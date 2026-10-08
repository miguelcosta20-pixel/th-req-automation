import type Database from 'better-sqlite3';
import type { ParsedEmail } from './types';
import type { Extraction } from './schema';
import type { FullResolution } from './resolve';
import type { LlmCallRecord, ReviewReason } from './types';
import type { SubmitResult } from './submit';

// ── Requisition ───────────────────────────────────────────────────────────────

// Inserts the requisition row, or reuses an existing one for the same message-id
// left behind by a prior failed attempt. Reuse clears that attempt's audit
// children and resets the row to 'processing' so this run starts clean. A row
// that already produced a PO is caught by the caller's idempotency check before
// this is reached, so we never disturb a completed requisition.
export function upsertRequisition(
  db:        Database.Database,
  email:     ParsedEmail,
  emailPath: string,
): number {
  const fields = {
    message_id:   email.messageId,
    email_path:   emailPath,
    sender_name:  email.from.name    ?? null,
    sender_email: email.from.address ?? null,
    subject:      email.subject,
    received_at:  email.receivedAt.toISOString(),
  };

  const existing = db.prepare(`SELECT id FROM requisition WHERE message_id = ?`)
    .get(email.messageId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`DELETE FROM llm_call    WHERE requisition_id = ?`).run(existing.id);
    db.prepare(`DELETE FROM review_item WHERE requisition_id = ?`).run(existing.id);
    db.prepare(`
      UPDATE requisition
      SET email_path = @email_path, sender_name = @sender_name, sender_email = @sender_email,
          subject = @subject, received_at = @received_at,
          status = 'processing', extraction_json = NULL, resolution_json = NULL, draft_reply = NULL,
          updated_at = datetime('now')
      WHERE id = @id
    `).run({ ...fields, id: existing.id });
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO requisition (message_id, email_path, sender_name, sender_email, subject, received_at)
    VALUES (@message_id, @email_path, @sender_name, @sender_email, @subject, @received_at)
  `).run(fields);
  return result.lastInsertRowid as number;
}

// Marks a requisition as failed when the pipeline threw partway through, and
// records the error as a review item so the queue shows a reason instead of a
// row stuck on 'processing'.
export function markRequisitionFailed(db: Database.Database, reqId: number, error: string): void {
  db.prepare(`UPDATE requisition SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(reqId);
  db.prepare(`INSERT INTO review_item (requisition_id, code, queue, detail) VALUES (?, 'processing_failed', 'human', ?)`)
    .run(reqId, error.slice(0, 500));
}

export function updateRequisitionStatus(
  db:      Database.Database,
  reqId:   number,
  status:  string,
  extras?: { extraction?: Extraction; resolution?: FullResolution; draftReply?: string },
): void {
  db.prepare(`
    UPDATE requisition
    SET status = @status,
        extraction_json = @extraction_json,
        resolution_json = @resolution_json,
        draft_reply     = @draft_reply,
        updated_at      = datetime('now')
    WHERE id = @id
  `).run({
    id:              reqId,
    status,
    extraction_json: extras?.extraction ? JSON.stringify(extras.extraction) : null,
    resolution_json: extras?.resolution ? JSON.stringify(extras.resolution) : null,
    draft_reply:     extras?.draftReply ?? null,
  });
}

// ── LLM calls ─────────────────────────────────────────────────────────────────

export function logLlmCall(
  db:     Database.Database,
  reqId:  number,
  record: LlmCallRecord,
): void {
  db.prepare(`
    INSERT INTO llm_call
      (requisition_id, prompt_version, model, input_sha256, output_text, parse_error,
       latency_ms, tokens_in, tokens_out, cost_chf, attempt, success)
    VALUES
      (@requisition_id, @prompt_version, @model, @input_sha256, @output_text, @parse_error,
       @latency_ms, @tokens_in, @tokens_out, @cost_chf, @attempt, @success)
  `).run({
    requisition_id: reqId,
    prompt_version: record.promptVersion,
    model:          record.model,
    input_sha256:   record.inputSha256,
    output_text:    record.outputText,
    parse_error:    record.parseError || null,
    latency_ms:     record.latencyMs,
    tokens_in:      record.tokensIn,
    tokens_out:     record.tokensOut,
    cost_chf:       record.costChf,
    attempt:        record.attempt,
    success:        record.success ? 1 : 0,
  });
}

// ── Review items ─────────────────────────────────────────────────────────────

export function insertReviewItems(
  db:      Database.Database,
  reqId:   number,
  reasons: ReviewReason[],
): void {
  const stmt = db.prepare(`
    INSERT INTO review_item (requisition_id, code, queue, detail)
    VALUES (@requisition_id, @code, @queue, @detail)
  `);
  for (const r of reasons) {
    stmt.run({ requisition_id: reqId, code: r.code, queue: r.queue, detail: r.detail });
  }
}

// ── PO ────────────────────────────────────────────────────────────────────────

export function insertPO(
  db:              Database.Database,
  reqId:           number,
  po:              SubmitResult,
  supplierId:      string,
  totalChf:        number,
  currency:        string,
  idempotencyKey:  string,
): void {
  db.prepare(`
    INSERT INTO po
      (requisition_id, po_number, supplier_id, currency, total_chf, idempotency_key, api_response_json)
    VALUES
      (@requisition_id, @po_number, @supplier_id, @currency, @total_chf, @idempotency_key, @api_response_json)
  `).run({
    requisition_id:    reqId,
    po_number:         po.poNumber,
    supplier_id:       supplierId,
    currency,
    total_chf:         totalChf,
    idempotency_key:   idempotencyKey,
    api_response_json: JSON.stringify(po),
  });
}
