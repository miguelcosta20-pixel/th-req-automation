import { describe, it, expect } from 'vitest';
import { decide } from '../src/decision/decide';
import type { Thresholds } from '../src/decision/decide';
import type { Extraction } from '../src/schema';
import type { FullResolution } from '../src/resolution/resolve';
import type { ResolvedDelivery } from '../src/resolution/delivery';
import type { ApprovalStep } from '../src/resolution/approvals';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const thresholds: Thresholds = { autoConfidence: 0.80, clarifyFloor: 0.50 };

const APPROVER: ApprovalStep = {
  employeeId: 'EMP-501',
  name:       'Andrea Roth',
  email:      'andrea.roth@customer.com',
  role:       'department_head',
};

// A resolved delivery with a usable date (explicit); and one with no date.
const resolvedDate: ResolvedDelivery = {
  kind: 'explicit', date: '2026-11-15', basis: 'explicit', urgency: null,
  timeframe: null, evidence: 'deliver by 15 Nov 2026', reasoning: null, note: null,
};
const noDeliveryDate: ResolvedDelivery = {
  kind: 'none', date: null, basis: 'none', urgency: null,
  timeframe: null, evidence: null, reasoning: null, note: null,
};

const goodExtraction: Extraction = {
  requester_name:         'Hans Meier',
  requester_email:        'hans.meier@customer.com',
  supplier_name:          'Acme Bearings GmbH',
  currency:               'EUR',
  cost_centre_hint:       'CC-1001',
  delivery:               { kind: 'explicit', explicit_date: '2026-11-15', timeframe: null, urgency: null, evidence: 'deliver by 15 Nov 2026', reasoning: null },
  line_items:             [{ description: 'Ball Bearing 6204', quantity: 10, unit: 'pcs', unit_price: 12.5, price_basis: null }],
  notes:                  null,
  instructions_to_reader: null,
  field_confidence:       { requester_name: 0.95, requester_email: 0.95, supplier_name: 0.95, currency: 0.95, line_items: 0.95 },
};

const goodResolution: FullResolution = {
  supplier: {
    match: { id: 'SUP-001', name: 'Acme Bearings GmbH', vat_id: null, country: 'DE', default_currency: 'EUR', payment_terms_days: 30, preferred: true, status: 'active' },
    score: 0.95, ambiguous: false,
  },
  costCentre: {
    match: { code: 'CC-1001', name: 'Plant Maintenance Schorndorf', owner_employee_id: 'EMP-101', department: 'OPS' },
    score: 0.95, ambiguous: false,
  },
  employee: {
    match: { id: 'EMP-101', name: 'Hans Meier', email: 'hans.meier@customer.com', role: 'cost_center_owner' },
    score: 0.95, ambiguous: false,
  },
  glAccount:        null,
  currency:         'EUR',
  computedTotalChf: 120.0,
  chain:            { ok: true, chain: [APPROVER] },
  delivery:         resolvedDate,
};

// ── Ready ─────────────────────────────────────────────────────────────────────

describe('decide — ready', () => {
  it('T55 — all conditions met → ready', () => {
    const d = decide(goodExtraction, goodResolution, thresholds);
    expect(d.status).toBe('ready');
    expect(d.reasons).toHaveLength(0);
    expect(d.draftReply).toBeUndefined();
  });
});

// ── Human review ──────────────────────────────────────────────────────────────

describe('decide — needs_human_review', () => {
  it('T56 — unknown supplier → human review', () => {
    const res: FullResolution = { ...goodResolution, supplier: null };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_human_review');
    expect(d.reasons.some(r => r.code === 'unknown_supplier')).toBe(true);
  });

  it('T57 — blocked supplier → human review', () => {
    const res: FullResolution = {
      ...goodResolution,
      supplier: {
        match: { id: 'SUP-018', name: 'Baltic Steel Trading', vat_id: null, country: 'LV', default_currency: 'EUR', payment_terms_days: 30, preferred: false, status: 'blocked' },
        score: 0.9, ambiguous: false,
      },
    };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_human_review');
    expect(d.reasons.some(r => r.code === 'blocked_supplier')).toBe(true);
  });

  it('T58 — ambiguous supplier → human review', () => {
    const res: FullResolution = {
      ...goodResolution,
      supplier: { ...goodResolution.supplier!, ambiguous: true },
    };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_human_review');
    expect(d.reasons.some(r => r.code === 'ambiguous_supplier')).toBe(true);
  });

  it('T59 — chain resolution failed (self-approval) → human review', () => {
    const res: FullResolution = {
      ...goodResolution,
      chain: { ok: false, reason: 'Requester EMP-101 is in the approval chain; remaining max level 0 < required 1' },
    };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_human_review');
    expect(d.reasons.some(r => r.code === 'no_approval_chain')).toBe(true);
  });

  it('T60 — confidence below clarifyFloor → human review', () => {
    const ext: Extraction = {
      ...goodExtraction,
      field_confidence: { requester_name: 0.9, requester_email: 0.9, supplier_name: 0.2, currency: 0.9, line_items: 0.9 },
    };
    const d = decide(ext, goodResolution, thresholds);
    expect(d.status).toBe('needs_human_review');
    expect(d.reasons.some(r => r.code === 'low_confidence' && r.queue === 'human')).toBe(true);
  });
});

// ── Clarification ─────────────────────────────────────────────────────────────

describe('decide — needs_clarification', () => {
  it('T61 — missing delivery date → clarification, draft reply included', () => {
    const res: FullResolution = { ...goodResolution, delivery: noDeliveryDate };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_clarification');
    expect(d.reasons.some(r => r.code === 'missing_delivery_date')).toBe(true);
    expect(d.draftReply).toBeTruthy();
    expect(d.draftReply).toContain('Required delivery date');
  });

  it('T62 — no cost centre resolved → clarification', () => {
    const res: FullResolution = { ...goodResolution, costCentre: null, chain: null };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_clarification');
    expect(d.reasons.some(r => r.code === 'missing_cost_centre')).toBe(true);
  });

  it('T63 — confidence between clarifyFloor and autoConfidence → clarification', () => {
    const ext: Extraction = {
      ...goodExtraction,
      field_confidence: { requester_name: 0.9, requester_email: 0.9, supplier_name: 0.65, currency: 0.9, line_items: 0.9 },
    };
    const d = decide(ext, goodResolution, thresholds);
    expect(d.status).toBe('needs_clarification');
    expect(d.reasons.some(r => r.code === 'low_confidence' && r.queue === 'clarification')).toBe(true);
  });

  it('T64 — missing delivery date + cost centre → clarification with both reasons', () => {
    const res: FullResolution = { ...goodResolution, delivery: noDeliveryDate, costCentre: null, chain: null };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_clarification');
    expect(d.reasons.some(r => r.code === 'missing_delivery_date')).toBe(true);
    expect(d.reasons.some(r => r.code === 'missing_cost_centre')).toBe(true);
    expect(d.draftReply).toBeTruthy();
  });

  it('T65 — draft reply mentions the supplier name', () => {
    const res: FullResolution = { ...goodResolution, delivery: noDeliveryDate };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.draftReply).toContain('Acme Bearings GmbH');
  });
});

// ── Mixed queues escalate to human ───────────────────────────────────────────

describe('decide — escalation', () => {
  it('T66 — missing date (clarification) + blocked supplier (human) → human review', () => {
    const res: FullResolution = {
      ...goodResolution,
      delivery: noDeliveryDate,
      supplier: {
        match: { id: 'SUP-018', name: 'Baltic Steel Trading', vat_id: null, country: 'LV', default_currency: 'EUR', payment_terms_days: 30, preferred: false, status: 'blocked' },
        score: 0.9, ambiguous: false,
      },
    };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_human_review');
  });
});

// ── Negative totals ───────────────────────────────────────────────────────────

describe('decide — negative total', () => {
  it('T66a — negative CHF total → human review with negative_total reason', () => {
    const res: FullResolution = { ...goodResolution, computedTotalChf: -150.0 };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.status).toBe('needs_human_review');
    expect(d.reasons.some(r => r.code === 'negative_total' && r.queue === 'human')).toBe(true);
  });

  it('T66b — negative total detail mentions the CHF amount', () => {
    const res: FullResolution = { ...goodResolution, computedTotalChf: -500.0 };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.reasons.find(r => r.code === 'negative_total')?.detail).toContain('-500.00');
  });

  it('T66c — zero total does not trigger negative_total', () => {
    const res: FullResolution = { ...goodResolution, computedTotalChf: 0 };
    const d = decide(goodExtraction, res, thresholds);
    expect(d.reasons.some(r => r.code === 'negative_total')).toBe(false);
  });
});
