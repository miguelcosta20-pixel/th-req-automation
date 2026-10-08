import { readFileSync } from 'fs';
import type Database from 'better-sqlite3';
import type { LlmClient } from './llm/client';
import type { AppConfig } from './config';
import type { ProcessResult } from './types';
import { ingestEml } from './ingest/ingest';
import { selectAttachments } from './ingest/attachments';
import { extractFromEmail, loadSystemPrompt } from './extraction/extract';
import { resolveRequisition } from './resolution/resolve';
import { decide } from './decision/decide';
import {
  upsertRequisition,
  updateRequisitionStatus,
  logLlmCall,
  insertReviewItems,
  markRequisitionFailed,
} from './output/audit';

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

    // Correction detection: if this email replies to a known requisition that has
    // not yet produced a PO, overwrite it in place rather than creating a new row.
    // If the parent already has a PO (submitted before the correction arrived),
    // fall through to normal processing — a separate row is created and the clerk
    // handles the discrepancy manually.
    let isCorrection = false;
    reqId = (() => {
      if (email.inReplyTo) {
        const parent = db.prepare(`
          SELECT r.id FROM requisition r
          LEFT JOIN po ON po.requisition_id = r.id
          WHERE r.message_id = ? AND po.id IS NULL
        `).get(email.inReplyTo) as { id: number } | undefined;

        if (parent) {
          // Take over the parent's row: update its message_id to this email's id
          // (so a second run of the correction is idempotent), clear stale audit data,
          // and reset to processing.
          db.prepare(`DELETE FROM llm_call    WHERE requisition_id = ?`).run(parent.id);
          db.prepare(`DELETE FROM review_item WHERE requisition_id = ?`).run(parent.id);
          db.prepare(`
            UPDATE requisition
            SET message_id    = @message_id,
                email_path    = @email_path,
                sender_name   = @sender_name,
                sender_email  = @sender_email,
                subject       = @subject,
                received_at   = @received_at,
                status        = 'processing',
                extraction_json  = NULL,
                resolution_json  = NULL,
                draft_reply      = NULL,
                updated_at    = datetime('now')
            WHERE id = @id
          `).run({
            id:           parent.id,
            message_id:   email.messageId,
            email_path:   emailPath,
            sender_name:  email.from.name    ?? null,
            sender_email: email.from.address ?? null,
            subject:      email.subject,
            received_at:  email.receivedAt.toISOString(),
          });
          isCorrection = true;
          return parent.id;
        }
      }
      // Normal path: insert new row or reuse a prior failed attempt's row.
      return upsertRequisition(db, email, emailPath);
    })();

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
      isCorrection,
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
      // All fields resolved — but PO submission is clerk-triggered after manual approval.
      // Store as waiting_approval so the clerk can go through the approval chain in the UI.
      updateRequisitionStatus(db, reqId, 'waiting_approval', { extraction, resolution });

      return {
        status:           'waiting_approval',
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
