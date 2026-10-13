// Tests for the two correction-detection paths in pipeline.ts.
// Both paths are purely deterministic DB queries — no LLM required.

import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../src/db';
import type Database from 'better-sqlite3';

// Minimal email fixture builder.
function makeEmail(overrides: {
  messageId?: string;
  inReplyTo?: string | null;
  senderEmail?: string;
  receivedAt?: string;
} = {}) {
  return {
    messageId:   overrides.messageId   ?? 'msg-original@test.com',
    inReplyTo:   overrides.inReplyTo   ?? null,
    from: { name: 'Test Sender', address: overrides.senderEmail ?? 'sender@toastwerk.com' },
    subject:     'Test requisition',
    textBody:    'Please order 10 units.',
    htmlBody:    '',
    receivedAt:  new Date(overrides.receivedAt ?? '2026-05-14T10:00:00Z'),
    attachments: [],
  };
}

// Insert a bare requisition row directly (no email parsing overhead).
function insertRequisition(
  db:          Database.Database,
  messageId:   string,
  senderEmail: string,
  receivedAt:  string,
  status:      string = 'waiting_approval',
): number {
  const result = db.prepare(`
    INSERT INTO requisition (message_id, email_path, sender_email, subject, received_at, status)
    VALUES (?, 'test.eml', ?, 'Test', ?, ?)
  `).run(messageId, senderEmail, receivedAt, status);
  return result.lastInsertRowid as number;
}

// Attach a fake PO to a requisition.
function insertFakePo(db: Database.Database, reqId: number, poNumber: string): void {
  db.prepare(`
    INSERT INTO po (requisition_id, po_number, supplier_id, currency, total_chf, idempotency_key)
    VALUES (?, ?, 'SUP-001', 'CHF', 1000, ?)
  `).run(reqId, poNumber, `key-${poNumber}`);
}

// ── Gap 1 query (In-Reply-To → parent has PO) ─────────────────────────────────

describe('Gap 1 — header-based correction, parent already has a PO', () => {
  let db: Database.Database;

  beforeEach(() => { db = initDb(':memory:'); });

  it('detects a parent requisition that already has a PO', () => {
    const parentId = insertRequisition(db, 'parent-msg@test.com', 'sender@test.com', '2026-05-13T09:00:00Z');
    insertFakePo(db, parentId, 'PO-2026-0099');

    const found = db.prepare(`
      SELECT r.id, po.po_number FROM requisition r
      JOIN po ON po.requisition_id = r.id
      WHERE r.message_id = ?
    `).get('parent-msg@test.com') as { id: number; po_number: string } | undefined;

    expect(found).toBeDefined();
    expect(found!.po_number).toBe('PO-2026-0099');
  });

  it('returns undefined when the parent has no PO', () => {
    insertRequisition(db, 'parent-msg@test.com', 'sender@test.com', '2026-05-13T09:00:00Z', 'waiting_approval');

    const found = db.prepare(`
      SELECT r.id, po.po_number FROM requisition r
      JOIN po ON po.requisition_id = r.id
      WHERE r.message_id = ?
    `).get('parent-msg@test.com') as { id: number; po_number: string } | undefined;

    expect(found).toBeUndefined();
  });

  it('returns undefined when the message-id is not in the DB', () => {
    const found = db.prepare(`
      SELECT r.id, po.po_number FROM requisition r
      JOIN po ON po.requisition_id = r.id
      WHERE r.message_id = ?
    `).get('unknown-msg@test.com') as { id: number; po_number: string } | undefined;

    expect(found).toBeUndefined();
  });
});

// ── Gap 2 query (sender + recency lookup) ─────────────────────────────────────

describe('Gap 2 — body-based correction, sender + recency lookup', () => {
  let db: Database.Database;

  beforeEach(() => { db = initDb(':memory:'); });

  const sender      = 'miriam.frick@toastwerk.com';
  const correctionId = 999;   // placeholder — the "new" row from the correction email
  const lookbackDate = '2026-05-08T00:00:00Z';   // 7 days before the correction

  it('finds the most recent unsubmitted requisition from the same sender', () => {
    const targetId = insertRequisition(db, 'cable-order@test.com', sender, '2026-05-14T10:05:00Z', 'waiting_approval');
    // Correction row that was just created (excluded from the lookup)
    insertRequisition(db, 'correction@test.com', sender, '2026-05-15T16:20:00Z', 'processing');
    const corrId = db.prepare(`SELECT id FROM requisition WHERE message_id = 'correction@test.com'`).get() as { id: number };

    const found = db.prepare(`
      SELECT r.id FROM requisition r
      LEFT JOIN po ON po.requisition_id = r.id
      WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ? AND po.id IS NULL
      ORDER BY r.received_at DESC LIMIT 1
    `).get(sender, lookbackDate, corrId.id) as { id: number } | undefined;

    expect(found).toBeDefined();
    expect(found!.id).toBe(targetId);
  });

  it('picks the most recent of multiple unsubmitted requisitions', () => {
    insertRequisition(db, 'old-req@test.com',    sender, '2026-05-09T08:00:00Z', 'needs_human_review');
    const newer = insertRequisition(db, 'newer-req@test.com', sender, '2026-05-13T15:00:00Z', 'waiting_approval');
    insertRequisition(db, 'correction@test.com', sender, '2026-05-15T16:20:00Z', 'processing');
    const corrId = db.prepare(`SELECT id FROM requisition WHERE message_id = 'correction@test.com'`).get() as { id: number };

    const found = db.prepare(`
      SELECT r.id FROM requisition r
      LEFT JOIN po ON po.requisition_id = r.id
      WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ? AND po.id IS NULL
      ORDER BY r.received_at DESC LIMIT 1
    `).get(sender, lookbackDate, corrId.id) as { id: number } | undefined;

    expect(found!.id).toBe(newer);
  });

  it('ignores requisitions from a different sender', () => {
    insertRequisition(db, 'other-req@test.com', 'other@toastwerk.com', '2026-05-14T10:00:00Z', 'waiting_approval');

    const found = db.prepare(`
      SELECT r.id FROM requisition r
      LEFT JOIN po ON po.requisition_id = r.id
      WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ? AND po.id IS NULL
      ORDER BY r.received_at DESC LIMIT 1
    `).get(sender, lookbackDate, correctionId) as { id: number } | undefined;

    expect(found).toBeUndefined();
  });

  it('ignores requisitions older than the 7-day lookback window', () => {
    insertRequisition(db, 'old-req@test.com', sender, '2026-05-01T10:00:00Z', 'waiting_approval');

    const found = db.prepare(`
      SELECT r.id FROM requisition r
      LEFT JOIN po ON po.requisition_id = r.id
      WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ? AND po.id IS NULL
      ORDER BY r.received_at DESC LIMIT 1
    `).get(sender, lookbackDate, correctionId) as { id: number } | undefined;

    expect(found).toBeUndefined();
  });

  it('detects when the most recent requisition from that sender already has a PO', () => {
    const targetId = insertRequisition(db, 'submitted@test.com', sender, '2026-05-14T10:00:00Z', 'waiting_approval');
    insertFakePo(db, targetId, 'PO-2026-0088');
    insertRequisition(db, 'correction@test.com', sender, '2026-05-15T16:20:00Z', 'processing');
    const corrId = db.prepare(`SELECT id FROM requisition WHERE message_id = 'correction@test.com'`).get() as { id: number };

    // Should find it via the with-PO query
    const withPo = db.prepare(`
      SELECT r.id, po.po_number FROM requisition r
      JOIN po ON po.requisition_id = r.id
      WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ?
      ORDER BY r.received_at DESC LIMIT 1
    `).get(sender, lookbackDate, corrId.id) as { id: number; po_number: string } | undefined;

    expect(withPo).toBeDefined();
    expect(withPo!.po_number).toBe('PO-2026-0088');

    // Should NOT appear in the no-PO query
    const noPo = db.prepare(`
      SELECT r.id FROM requisition r
      LEFT JOIN po ON po.requisition_id = r.id
      WHERE r.sender_email = ? AND r.received_at >= ? AND r.id != ? AND po.id IS NULL
      ORDER BY r.received_at DESC LIMIT 1
    `).get(sender, lookbackDate, corrId.id) as { id: number } | undefined;

    expect(noPo).toBeUndefined();
  });
});
