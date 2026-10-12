import { readFileSync } from 'fs';
import type Database from 'better-sqlite3';
import type { LlmClient } from './llm/client';
import type { AppConfig } from './config';
import type { ProcessResult, ReviewReason, ParsedEmail, DocumentBlock } from './types';
import type { Extraction } from './schema';
import { ingestEml } from './ingest/ingest';
import { selectAttachments } from './ingest/attachments';
import { extractFromEmail, mergeCorrection, loadSystemPrompt } from './extraction/extract';
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

    // Gap 1: header-based correction that arrives AFTER the original PO was already
    // submitted. We can't auto-overwrite — flag it for the clerk instead.
    if (email.inReplyTo) {
      const parentWithPo = db.prepare(`
        SELECT r.id, po.po_number FROM requisition r
        JOIN po ON po.requisition_id = r.id
        WHERE r.message_id = ?
      `).get(email.inReplyTo) as { id: number; po_number: string } | undefined;

      if (parentWithPo) {
        reqId = upsertRequisition(db, email, emailPath);
        const reason: ReviewReason = {
          code:   'amendment_after_po',
          queue:  'human',
          detail: `This email corrects a previous request but PO ${parentWithPo.po_number} was already submitted. Manual reconciliation required.`,
        };
        insertReviewItems(db, reqId, [reason]);
        const draftReply =
          `Subject: Re: ${email.subject}\n\n` +
          `Dear ${email.from.name ?? email.from.address ?? 'Requester'},\n\n` +
          `Your amendment was received, but a purchase order (${parentWithPo.po_number}) has already been submitted for the original request. ` +
          `Our purchasing team will review and be in touch to discuss next steps.\n\n` +
          `Kind regards,\nPurchasing Team`;
        updateRequisitionStatus(db, reqId, 'needs_human_review', { draftReply });
        return {
          status:    'needs_human_review',
          emailPath,
          messageId: email.messageId,
          reasons:   [reason],
        };
      }
    }

    // The correction email always gets its OWN requisition row. (A prior failed
    // attempt with the same message-id is reused by upsertRequisition.) We never
    // overwrite the original row — corrections are merged onto a copy and sent to
    // human review, leaving the original intact for the clerk to reconcile.
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

    // Thread-based correction, parent not yet a PO: merge the correction onto the
    // original rather than extracting the (often terse) reply on its own. Runs
    // before extraction so we never lose the original's data. Always routes to
    // human review; the original row is preserved.
    if (email.inReplyTo) {
      const parentNoPo = db.prepare(`
        SELECT r.id, r.subject, r.extraction_json FROM requisition r
        LEFT JOIN po ON po.requisition_id = r.id
        WHERE r.message_id = ? AND po.id IS NULL
      `).get(email.inReplyTo) as { id: number; subject: string; extraction_json: string | null } | undefined;

      if (parentNoPo) {
        return applyCorrectionMerge(
          { db, client, config },
          {
            correctionReqId:  reqId,
            correctionEmail:  email,
            correctionBlocks: documentBlocks,
            originalRow:      parentNoPo,
            emailPath,
            systemPrompt,
            model,
            onStage,
          },
        );
      }
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
      const draftReply =
        `Subject: Re: ${email.subject}\n\n` +
        `Dear ${email.from.name ?? email.from.address ?? 'Requester'},\n\n` +
        `We were unable to automatically process your purchase requisition. ` +
        `Our team will review it manually and be in touch shortly.\n\n` +
        `Kind regards,\nPurchasing Team`;
      updateRequisitionStatus(db, reqId, 'needs_human_review', { draftReply });
      return {
        status:    'needs_human_review',
        emailPath,
        messageId: email.messageId,
        reasons:   [{ code: 'extraction_failed', queue: 'human', detail: 'LLM extraction failed after retry' }],
      };
    }

    // Gap 2: body-based correction detected by the LLM (no In-Reply-To header).
    // Look up the most recent unsubmitted requisition from the same sender within
    // 7 days. Route to human review in all sub-cases: the clerk confirms the match
    // before any records are altered.
    if (extraction.is_correction && email.from.address) {
      const senderEmail  = email.from.address;
      const lookbackDate = new Date(email.receivedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const amendNote    = extraction.amends_description ? ` ${extraction.amends_description}` : '';

      // Check whether the most recent matching requisition already has a PO.
      const targetWithPo = db.prepare(`
        SELECT r.id, po.po_number FROM requisition r
        JOIN po ON po.requisition_id = r.id
        WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ?
        ORDER BY r.received_at DESC LIMIT 1
      `).get(senderEmail, lookbackDate, reqId) as { id: number; po_number: string } | undefined;

      if (targetWithPo) {
        const reason: ReviewReason = {
          code:   'amendment_after_po',
          queue:  'human',
          detail: `Email corrects a previous request but PO ${targetWithPo.po_number} was already submitted. Manual reconciliation required.${amendNote}`,
        };
        insertReviewItems(db, reqId, [reason]);
        const name = extraction.requester_name ?? extraction.requester_email ?? email.from.name ?? 'Requester';
        const draftReply =
          `Subject: Re: ${email.subject}\n\n` +
          `Dear ${name},\n\n` +
          `Your amendment was received, but a purchase order (${targetWithPo.po_number}) has already been submitted for your previous request. ` +
          `Our purchasing team will review and be in touch to discuss next steps.\n\n` +
          `Kind regards,\nPurchasing Team`;
        updateRequisitionStatus(db, reqId, 'needs_human_review', { draftReply });
        return {
          status:    'needs_human_review',
          emailPath,
          messageId: email.messageId,
          reasons:   [reason],
        };
      }

      const targetNoPo = db.prepare(`
        SELECT r.id, r.subject, r.extraction_json FROM requisition r
        LEFT JOIN po ON po.requisition_id = r.id
        WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ? AND po.id IS NULL
        ORDER BY r.received_at DESC LIMIT 1
      `).get(senderEmail, lookbackDate, reqId) as { id: number; subject: string; extraction_json: string | null } | undefined;

      if (targetNoPo) {
        // Target found and still pending — merge the correction onto it (human review).
        return applyCorrectionMerge(
          { db, client, config },
          {
            correctionReqId:  reqId,
            correctionEmail:  email,
            correctionBlocks: documentBlocks,
            originalRow:      targetNoPo,
            emailPath,
            systemPrompt,
            model,
            onStage,
          },
        );
      }

      // No recent requisition from this sender — no original on record to merge.
      // Note it and continue so the corrected values are still processed on their own.
      insertReviewItems(db, reqId, [{
        code:   'correction_target_not_found',
        queue:  'human',
        detail: `Email indicates it corrects a previous request but no recent unsubmitted requisition from ${senderEmail} was found; no original on record to merge.${amendNote}`,
      }]);
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

interface CorrectionMergeArgs {
  correctionReqId:  number;             // the correction email's own requisition row
  correctionEmail:  ParsedEmail;
  correctionBlocks: DocumentBlock[];
  originalRow:      { id: number; subject: string; extraction_json: string | null };
  emailPath:        string;             // path of the correction .eml (for the result)
  systemPrompt:     string;
  model:            string;
  onStage?:         RunDeps['onStage'];
}

// Merges a correction onto its original requisition and routes the result to
// human review (or the security queue if the merged content trips the security
// check). The original row is never modified — the clerk reconciles the two.
// Runs on its own requisition row (correctionReqId); the merged extraction and
// resolution are stored there so the clerk sees the final intended values.
async function applyCorrectionMerge(
  { db, client, config }: Pick<RunDeps, 'db' | 'client' | 'config'>,
  args: CorrectionMergeArgs,
): Promise<ProcessResult> {
  const { correctionReqId, correctionEmail, correctionBlocks, originalRow, emailPath,
          systemPrompt, model, onStage } = args;

  const flagForReview = (code: string, detail: string): ProcessResult => {
    const reason: ReviewReason = { code, queue: 'human', detail };
    insertReviewItems(db, correctionReqId, [reason]);
    updateRequisitionStatus(db, correctionReqId, 'needs_human_review', {
      draftReply: buildCorrectionReply(correctionEmail),
    });
    return { status: 'needs_human_review', emailPath, messageId: correctionEmail.messageId, reasons: [reason] };
  };

  // Merge onto the original's already-extracted structured data, not its raw
  // email. This preserves line items that came from a PDF or from an earlier
  // correction in the chain. If the original has no usable extraction, we cannot merge.
  let originalExtraction: Extraction;
  try {
    if (!originalRow.extraction_json) throw new Error('no stored extraction');
    originalExtraction = JSON.parse(originalRow.extraction_json) as Extraction;
  } catch {
    return flagForReview(
      'correction_merge_failed',
      `Detected a correction to requisition #${originalRow.id} but the original has no usable extraction on record; manual reconciliation required.`,
    );
  }

  onStage?.('extract');
  const { extraction: merged, calls } = await mergeCorrection(
    originalExtraction, correctionEmail, correctionBlocks, client, systemPrompt, model,
  );
  for (const call of calls) logLlmCall(db, correctionReqId, call);

  if (!merged) {
    return flagForReview(
      'correction_merge_failed',
      `Detected a correction to requisition #${originalRow.id} but automatic merge failed; manual reconciliation required.`,
    );
  }

  // Resolve + decide on the merged values so the clerk also sees any field
  // problems. A correction can itself carry an injection attempt, so if the
  // merged content trips the security check, route to the security queue;
  // otherwise force human review (merged corrections never auto-advance).
  onStage?.('resolve');
  const resolution = resolveRequisition(
    merged, config.masterData, correctionEmail.receivedAt, config.thresholds.defaultDeliveryLeadDays,
  );
  onStage?.('decide');
  const decision = decide(merged, resolution, config.thresholds);
  const finalStatus = decision.status === 'security' ? 'security' : 'needs_human_review';

  const mergeReason: ReviewReason = {
    code:   'amendment_merged',
    queue:  'human',
    detail: `Merged correction onto original requisition #${originalRow.id} ("${originalRow.subject ?? ''}"). Review merged values before approval; the original row remains for reference.`,
  };
  const reasons = [mergeReason, ...decision.reasons];
  insertReviewItems(db, correctionReqId, reasons);

  const draftReply = buildCorrectionReply(correctionEmail);
  updateRequisitionStatus(db, correctionReqId, finalStatus, {
    extraction: merged, resolution, draftReply,
  });

  // Link the correction to its original. The original is NOT parked here — the
  // clerk resolves it in the demo (supersede the original or discard this
  // correction); until then the submit guard blocks the original's PO.
  db.prepare(`UPDATE requisition SET supersedes_requisition_id = ? WHERE id = ?`)
    .run(originalRow.id, correctionReqId);

  return {
    status:           finalStatus,
    emailPath,
    messageId:        correctionEmail.messageId,
    totalChf:         resolution.computedTotalChf,
    supplier:         resolution.supplier?.match?.name,
    supplierId:       resolution.supplier?.match?.id,
    costCentreCode:   resolution.costCentre?.match?.code,
    currency:         resolution.currency,
    approvalChainIds: resolution.chain?.ok ? resolution.chain.chain.map(s => s.employeeId) : undefined,
    hasDeliveryDate:  !!resolution.delivery.date,
    lineItemCount:    merged.line_items?.length ?? 0,
    reasons,
    draftReply,
  };
}

function buildCorrectionReply(email: ParsedEmail): string {
  const name = email.from.name ?? email.from.address ?? 'Requester';
  return (
    `Subject: Re: ${email.subject}\n\n` +
    `Dear ${name},\n\n` +
    `Your amendment was received. Our team will review the changes against your previous request and confirm with you shortly.\n\n` +
    `Kind regards,\nPurchasing Team`
  );
}
