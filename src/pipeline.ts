import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { LlmClient } from './llm/client';
import type { AppConfig } from './config';
import type { ProcessResult } from './types';
import { ingestEml } from './ingest';
import { selectAttachments } from './attachments';
import { extractFromEmail, loadSystemPrompt } from './extract';
import { resolveRequisition } from './resolve';
import { decide } from './decide';
import { submitPO } from './submit';
import {
  upsertRequisition,
  updateRequisitionStatus,
  logLlmCall,
  insertReviewItems,
  insertPO,
  markRequisitionFailed,
} from './audit';

interface RunDeps {
  db:     Database.Database;
  client: LlmClient;
  config: AppConfig;
  // Optional progress hook. Instrumentation only — it never affects routing or
  // output. The demo server uses it to stream live stage updates; the CLI and
  // eval harness omit it. Called at the start of each phase.
  onStage?: (stage: 'ingest' | 'extract' | 'resolve' | 'decide' | 'submit') => void;
}

// Processes a single .eml file end-to-end.
// All errors are caught and returned as a 'failed' result so run-all can continue.
export async function processEml(
  emailPath: string,
  { db, client, config, onStage }: RunDeps,
): Promise<ProcessResult> {
  const systemPrompt = loadSystemPrompt();
  const model        = config.models.extraction;

  let reqId: number | undefined;   // set once the requisition row exists; used by the catch

  try {
    onStage?.('ingest');
    const raw   = readFileSync(emailPath);
    const email = await ingestEml(raw);

    // Idempotency: if this message-id already produced a PO, return it.
    const existingPO = (db.prepare(`
      SELECT po.po_number, po.total_chf, po.supplier_id
      FROM po
      JOIN requisition ON po.requisition_id = requisition.id
      WHERE requisition.message_id = ?
    `).get(email.messageId)) as { po_number: string; total_chf: number; supplier_id: string } | undefined;

    if (existingPO) {
      return {
        status:    'duplicate',
        emailPath,
        messageId: email.messageId,
        poNumber:  existingPO.po_number,
        totalChf:  existingPO.total_chf,
        supplier:  existingPO.supplier_id,
      };
    }

    // Insert (or reuse a prior failed attempt's) requisition row so audit
    // references are valid even on failure.
    reqId = upsertRequisition(db, email, emailPath);

    // Attachments: select PDFs within page limit
    const { documentBlocks, overLimitFilenames } = selectAttachments(
      email.attachments,
      config.thresholds.pdfPageLimit,
    );

    if (overLimitFilenames.length > 0) {
      // Flag over-limit files but continue — the model extracts from email text alone
      insertReviewItems(db, reqId, overLimitFilenames.map(f => ({
        code:   'over_page_limit',
        queue:  'human' as const,
        detail: `PDF exceeds page limit: ${f}`,
      })));
    }

    // LLM extraction
    onStage?.('extract');
    const { extraction, calls } = await extractFromEmail(
      email,
      documentBlocks,
      client,
      systemPrompt,
      model,
    );

    for (const call of calls) logLlmCall(db, reqId, call);

    if (!extraction) {
      updateRequisitionStatus(db, reqId, 'needs_human_review');
      return {
        status:    'needs_human_review',
        emailPath,
        messageId: email.messageId,
        reasons:   [{ code: 'extraction_failed', queue: 'human', detail: 'LLM extraction failed after retry' }],
      };
    }

    // Master-data resolution (relative delivery timeframes anchor on the email date)
    onStage?.('resolve');
    const resolution = resolveRequisition(extraction, config.masterData, email.receivedAt, config.thresholds.defaultDeliveryLeadDays);

    // Status decision
    onStage?.('decide');
    const decision = decide(extraction, resolution, config.thresholds);

    if (decision.status === 'ready') {
      onStage?.('submit');
      const idempotencyKey = computeIdempotencyKey(
        email.messageId,
        resolution.supplier?.match?.id ?? '',
        resolution.computedTotalChf,
      );

      const po = await submitPO(config.poApiUrl, resolution, extraction, idempotencyKey);

      insertPO(
        db,
        reqId,
        po,
        resolution.supplier!.match!.id,
        resolution.computedTotalChf,
        resolution.currency,
        idempotencyKey,
      );

      updateRequisitionStatus(db, reqId, 'submitted', { extraction, resolution });

      return {
        status:            'submitted',
        emailPath,
        messageId:         email.messageId,
        poNumber:          po.poNumber,
        totalChf:          resolution.computedTotalChf,
        supplier:          resolution.supplier?.match?.name,
        supplierId:        resolution.supplier?.match?.id,
        costCentreCode:    resolution.costCentre?.match?.code,
        currency:          resolution.currency,
        approvalChainIds:  resolution.chain?.ok ? resolution.chain.chain.map(s => s.employeeId) : undefined,
        hasDeliveryDate:   !!resolution.delivery.date,
        lineItemCount:     extraction.line_items?.length ?? 0,
      };
    }

    insertReviewItems(db, reqId, decision.reasons);
    updateRequisitionStatus(db, reqId, decision.status, {
      extraction,
      resolution,
      draftReply: decision.draftReply,
    });

    return {
      status:           decision.status,
      emailPath,
      messageId:        email.messageId,
      totalChf:         resolution.computedTotalChf,
      supplier:         resolution.supplier?.match?.name,
      supplierId:       resolution.supplier?.match?.id,
      costCentreCode:   resolution.costCentre?.match?.code,
      currency:         resolution.currency,
      approvalChainIds: resolution.chain?.ok ? resolution.chain.chain.map(s => s.employeeId) : undefined,
      hasDeliveryDate:  !!resolution.delivery.date,
      lineItemCount:    extraction.line_items?.length ?? 0,
      reasons:          decision.reasons,
      draftReply:       decision.draftReply,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A throw partway through leaves the requisition row behind — mark it failed
    // (with the error as a review reason) so it is not stuck on 'processing' and
    // a later run can cleanly reprocess it. Best-effort: never mask the original error.
    if (reqId !== undefined) {
      try { markRequisitionFailed(db, reqId, message); } catch { /* ignore */ }
    }
    return { status: 'failed', emailPath, error: message };
  }
}

// D17: idempotency key = sha256(message_id + supplier_id + totalChf rounded to 2 dp).
function computeIdempotencyKey(
  messageId:  string,
  supplierId: string,
  totalChf:   number,
): string {
  const payload = `${messageId}|${supplierId}|${totalChf.toFixed(2)}`;
  return createHash('sha256').update(payload).digest('hex');
}
