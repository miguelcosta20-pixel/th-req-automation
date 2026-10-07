import type Database from 'better-sqlite3';
import type { ParsedEmail } from './types';
import type { Extraction } from './schema';
import type { FullResolution } from './resolve';
import type { LlmCallRecord, ReviewReason } from './types';
import type { SubmitResult } from './submit';

// ── Requisition ───────────────────────────────────────────────────────────────

export function insertRequisition(
  db:        Database.Database,
  email:     ParsedEmail,
  emailPath: string,
): number {
  const stmt = db.prepare(`
    INSERT INTO requisition (message_id, email_path, sender_name, sender_email, subject, received_at)
    VALUES (@message_id, @email_path, @sender_name, @sender_email, @subject, @received_at)
  `);
  const result = stmt.run({
    message_id:   email.messageId,
    email_path:   emailPath,
    sender_name:  email.from.name  ?? null,
    sender_email: email.from.address ?? null,
    subject:      email.subject,
    received_at:  email.receivedAt.toISOString(),
  });
  return result.lastInsertRowid as number;
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
