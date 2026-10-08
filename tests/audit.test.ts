import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../src/db';
import { upsertRequisition, markRequisitionFailed, insertReviewItems } from '../src/output/audit';
import type { ParsedEmail } from '../src/types';

function email(messageId: string): ParsedEmail {
  return {
    messageId,
    from: { name: 'Hans Meier', address: 'hans.meier@customer.com' },
    subject: 'Order',
    textBody: 'body',
    htmlBody: '',
    receivedAt: new Date('2026-05-14T08:00:00.000Z'),
    attachments: [],
  };
}

describe('requisition upsert + failure handling', () => {
  let db: Database.Database;
  beforeEach(() => { db = initDb(':memory:'); });

  it('T96 — re-processing the same message-id reuses the row (no UNIQUE collision)', () => {
    const first  = upsertRequisition(db, email('<m-1@x>'), 'a.eml');
    const second = upsertRequisition(db, email('<m-1@x>'), 'a.eml');
    expect(second).toBe(first);
    const count = db.prepare(`SELECT count(*) n FROM requisition WHERE message_id = '<m-1@x>'`).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('T97 — a failed run marks the row failed and records a reason', () => {
    const id = upsertRequisition(db, email('<m-2@x>'), 'b.eml');
    markRequisitionFailed(db, id, '400 INVALID_MODEL: claude-sonnet-5-5 not supported');
    const row = db.prepare(`SELECT status FROM requisition WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe('failed');
    const review = db.prepare(`SELECT code, detail FROM review_item WHERE requisition_id = ?`).get(id) as { code: string; detail: string };
    expect(review.code).toBe('processing_failed');
    expect(review.detail).toContain('INVALID_MODEL');
  });

  it('T98 — reusing a failed row resets it to processing and clears prior children', () => {
    const id = upsertRequisition(db, email('<m-3@x>'), 'c.eml');
    insertReviewItems(db, id, [{ code: 'low_confidence', queue: 'clarification', detail: 'x' }]);
    markRequisitionFailed(db, id, 'boom');

    const again = upsertRequisition(db, email('<m-3@x>'), 'c.eml');
    expect(again).toBe(id);
    const row = db.prepare(`SELECT status FROM requisition WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe('processing');
    const n = db.prepare(`SELECT count(*) n FROM review_item WHERE requisition_id = ?`).get(id) as { n: number };
    expect(n.n).toBe(0);   // prior review items cleared for a clean reprocess
  });
});
