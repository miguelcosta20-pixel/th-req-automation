// End-to-end routing test for the correction-merge path in pipeline.ts.
// The LLM is faked (no network): the fake dispatches on the "MERGE TASK" marker
// that mergeCorrection() puts in the user message, returning a canned original
// extraction (2 desks) for a normal extraction and a merged one (5 desks) for a
// merge. Everything downstream (resolve, decide, DB writes, routing) is real.

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'path';
import type Database from 'better-sqlite3';
import { initDb } from '../src/db';
import { loadConfig } from '../src/config';
import { processEml } from '../src/pipeline';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm/client';

const ORIGINAL_EML   = resolve(process.cwd(), 'data/test-emails/corr_original_desks.eml');
const CORRECTION_EML = resolve(process.cwd(), 'data/test-emails/corr_reply_qty.eml');
const MULTIHOP_EML   = resolve(process.cwd(), 'data/test-emails/corr_reply_multihop.eml');
const ORIGINAL_MSGID   = 'corr-orig-desks@customer.com';
const CORRECTION_MSGID = 'corr-reply-qty@customer.com';
const MULTIHOP_MSGID   = 'corr-reply-multihop@customer.com';

// A complete, schema-valid extraction. `quantity` lets each canned response
// differ by the one field the correction changes.
function extractionJson(quantity: number, isCorrection: boolean): string {
  return JSON.stringify({
    requester_name:  'Luca Ferrari',
    requester_email: 'luca.ferrari@customer.com',
    supplier_name:   'Office Plus Schweiz',
    currency:        'CHF',
    cost_centre_hint: 'CC-3001',
    category_hint:   'office supplies',
    delivery: {
      kind: 'explicit', explicit_date: '2026-10-31', timeframe: 'by 31 October 2026',
      urgency: 'normal', evidence: 'delivered by 31 October 2026', reasoning: 'explicit calendar date',
    },
    line_items: [{
      description: 'Sit-stand desk SSD-140, electric', quantity, unit: 'pcs',
      unit_price: 420, price_basis: 'per_unit', currency: 'CHF', item_code: 'SSD-140',
    }],
    notes: null,
    instructions_to_reader: null,
    is_correction: isCorrection,
    amends_description: isCorrection ? 'Quantity correction: 5 desks not 2; all else unchanged.' : null,
    field_confidence: {
      requester_name: 1, requester_email: 1, supplier_name: 1, currency: 1,
      line_items: 1, delivery_date: 1, cost_centre: 1, category_hint: 0.9,
    },
  });
}

// Fake LLM: merge call (text contains "MERGE TASK") → 5 desks; otherwise → 2.
// Records every request so tests can assert what the merge was actually fed.
class FakeLlmClient implements LlmClient {
  requests: LlmRequest[] = [];
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const firstText = req.messages[0].content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n');
    const isMerge = firstText.includes('MERGE TASK');
    return {
      text:      extractionJson(isMerge ? 5 : 2, isMerge),
      model:     req.model,
      usage:     { tokensIn: 100, tokensOut: 100 },
      latencyMs: 1,
    };
  }

  // Text of the most recent request that was a merge (contains "MERGE TASK").
  lastMergeText(): string | undefined {
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const t = this.requests[i].messages[0].content
        .map(b => (b.type === 'text' ? b.text : '')).join('\n');
      if (t.includes('MERGE TASK')) return t;
    }
    return undefined;
  }
}

function extractionFor(db: Database.Database, messageId: string) {
  const row = db.prepare(
    `SELECT status, extraction_json FROM requisition WHERE message_id = ?`,
  ).get(messageId) as { status: string; extraction_json: string | null } | undefined;
  return row;
}

describe('correction merge — thread reply onto a not-yet-submitted original', () => {
  let db: Database.Database;
  let fake: FakeLlmClient;
  let deps: { db: Database.Database; client: LlmClient; config: ReturnType<typeof loadConfig> };

  beforeEach(() => {
    db = initDb(':memory:');
    fake = new FakeLlmClient();
    const config = loadConfig(resolve(process.cwd(), 'config/toastwerk/config.json'));
    deps = { db, client: fake, config };
  });

  it('preserves the original row and creates a merged correction routed to human review', async () => {
    await processEml(ORIGINAL_EML, deps);
    const result = await processEml(CORRECTION_EML, deps);

    // Correction routed to human review — never auto-advanced.
    expect(result.status).toBe('needs_human_review');
    expect(result.status).not.toBe('waiting_approval');

    // Original row preserved, not wiped: still has its extraction and quantity 2.
    const original = extractionFor(db, ORIGINAL_MSGID);
    expect(original).toBeDefined();
    expect(original!.extraction_json).not.toBeNull();
    const origExtraction = JSON.parse(original!.extraction_json!);
    expect(origExtraction.line_items[0].quantity).toBe(2);

    // A distinct correction row exists with the merged quantity and preserved supplier.
    const correction = extractionFor(db, CORRECTION_MSGID);
    expect(correction).toBeDefined();
    expect(correction!.status).toBe('needs_human_review');
    const mergedExtraction = JSON.parse(correction!.extraction_json!);
    expect(mergedExtraction.line_items[0].quantity).toBe(5);
    expect(mergedExtraction.supplier_name).toBe('Office Plus Schweiz');

    // The two rows are distinct.
    const count = db.prepare(`SELECT COUNT(*) AS n FROM requisition`).get() as { n: number };
    expect(count.n).toBe(2);

    // The correction links back to its original (so the UI can connect them and
    // the submit guard can block a second PO on the original).
    const origRow = db.prepare(`SELECT id FROM requisition WHERE message_id = ?`)
      .get(ORIGINAL_MSGID) as { id: number };
    const link = db.prepare(`SELECT supersedes_requisition_id AS sid FROM requisition WHERE message_id = ?`)
      .get(CORRECTION_MSGID) as { sid: number | null };
    expect(link.sid).toBe(origRow.id);

    // The correction row carries the amendment_merged review item referencing the original.
    const corrId = db.prepare(`SELECT id FROM requisition WHERE message_id = ?`)
      .get(CORRECTION_MSGID) as { id: number };
    const codes = db.prepare(`SELECT code FROM review_item WHERE requisition_id = ?`)
      .all(corrId.id) as Array<{ code: string }>;
    expect(codes.map(c => c.code)).toContain('amendment_merged');
  });

  it('feeds the merge the original stored extraction, not the terse reply body (L1 fix)', async () => {
    await processEml(ORIGINAL_EML, deps);
    await processEml(CORRECTION_EML, deps);

    // The merge is built from the original's structured extraction, which carries
    // fields the terse reply never mentions (supplier, item code). If the original's
    // items had come from a PDF, they would survive the merge for the same reason.
    const mergeText = fake.lastMergeText();
    expect(mergeText).toBeDefined();
    expect(mergeText!).toContain('ORIGINAL (structured JSON)');
    expect(mergeText!).toContain('Office Plus Schweiz');   // supplier — absent from the reply body
    expect(mergeText!).toContain('SSD-140');               // line item — absent from the reply body
  });

  it('merges a reply-to-a-correction onto that correction\'s stored complete extraction (L2 multi-hop fix)', async () => {
    await processEml(ORIGINAL_EML, deps);        // 2 desks, full details
    await processEml(CORRECTION_EML, deps);      // correction1 → stored as a COMPLETE merged extraction (5 desks)
    const result = await processEml(MULTIHOP_EML, deps);  // correction2 replies to correction1

    expect(result.status).toBe('needs_human_review');

    // correction2's merge base is correction1's STORED extraction, which is complete
    // (supplier + line item) — so a correction-of-a-correction does not lose the order.
    const mergeText = fake.lastMergeText();
    expect(mergeText!).toContain('Office Plus Schweiz');
    expect(mergeText!).toContain('SSD-140');

    const corrId = db.prepare(`SELECT id FROM requisition WHERE message_id = ?`)
      .get(MULTIHOP_MSGID) as { id: number };
    const codes = db.prepare(`SELECT code FROM review_item WHERE requisition_id = ?`)
      .all(corrId.id) as Array<{ code: string }>;
    expect(codes.map(c => c.code)).toContain('amendment_merged');
  });
});
