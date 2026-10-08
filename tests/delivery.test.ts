import { describe, it, expect } from 'vitest';
import { resolveDelivery, resolveRelative } from '../src/delivery';
import type { Delivery } from '../src/schema';

// Anchor: a fixed email send date so relative resolution is deterministic.
const ANCHOR = new Date('2026-05-14T08:00:00.000Z');

function delivery(partial: Partial<Delivery> & Pick<Delivery, 'kind'>): Delivery {
  return { explicit_date: null, timeframe: null, urgency: null, evidence: null, reasoning: null, ...partial };
}

// ── resolveRelative — the deterministic parser ────────────────────────────────

describe('resolveRelative', () => {
  it('T80 — "next week" → anchor + 7 days', () => {
    expect(resolveRelative('next week', ANCHOR)?.date).toBe('2026-05-21');
  });
  it('T81 — "within 2 weeks" → anchor + 14 days', () => {
    expect(resolveRelative('within 2 weeks', ANCHOR)?.date).toBe('2026-05-28');
  });
  it('T82 — "6 weeks ex works" → anchor + 42 days', () => {
    expect(resolveRelative('6 weeks ex works Veldhoven', ANCHOR)?.date).toBe('2026-06-25');
  });
  it('T83 — "in 10 days" → anchor + 10 days', () => {
    expect(resolveRelative('in 10 days', ANCHOR)?.date).toBe('2026-05-24');
  });
  it('T84 — "tomorrow" → anchor + 1 day', () => {
    expect(resolveRelative('tomorrow', ANCHOR)?.date).toBe('2026-05-15');
  });
  it('T85 — "end of month" → last day of the anchor month', () => {
    expect(resolveRelative('by end of month', ANCHOR)?.date).toBe('2026-05-31');
  });
  it('T86 — "next month" → anchor + 30 days', () => {
    expect(resolveRelative('next month', ANCHOR)?.date).toBe('2026-06-13');
  });
  it('T87 — unparseable phrase → null (leaves it to a human)', () => {
    expect(resolveRelative('soon-ish, whenever', ANCHOR)).toBeNull();
    expect(resolveRelative('ASAP', ANCHOR)).toBeNull();
  });
});

// ── resolveDelivery — classification → resolution ─────────────────────────────

describe('resolveDelivery', () => {
  it('T88 — explicit date passes through, basis=explicit', () => {
    const r = resolveDelivery(delivery({ kind: 'explicit', explicit_date: '2026-06-30' }), ANCHOR);
    expect(r).toMatchObject({ date: '2026-06-30', basis: 'explicit' });
  });
  it('T89 — malformed explicit date → no date (never invent)', () => {
    const r = resolveDelivery(delivery({ kind: 'explicit', explicit_date: '30/06/2026' }), ANCHOR);
    expect(r.date).toBeNull();
    expect(r.basis).toBe('none');
  });
  it('T90 — relative resolves to a date, basis=relative, note recorded', () => {
    const r = resolveDelivery(delivery({ kind: 'relative', timeframe: 'next week' }), ANCHOR);
    expect(r).toMatchObject({ date: '2026-05-21', basis: 'relative' });
    expect(r.note).toContain('next week');
  });
  it('T90a — model-resolved explicit_date on a relative is trusted (phrase the parser cannot handle)', () => {
    const r = resolveDelivery(delivery({ kind: 'relative', timeframe: 'Bis Ende Mai', explicit_date: '2026-05-31' }), ANCHOR);
    expect(r).toMatchObject({ date: '2026-05-31', basis: 'relative' });
    expect(r.note).toContain('Model-resolved');
  });
  it('T90b — model date before the email date is rejected, parser used instead', () => {
    const r = resolveDelivery(delivery({ kind: 'relative', timeframe: 'next week', explicit_date: '2020-01-01' }), ANCHOR);
    expect(r.date).toBe('2026-05-21');   // fell back to the parser, not the past date
  });
  it('T90c — malformed model date on a relative falls back to the parser', () => {
    const r = resolveDelivery(delivery({ kind: 'relative', timeframe: 'in 10 days', explicit_date: '31/05/2026' }), ANCHOR);
    expect(r.date).toBe('2026-05-24');
  });
  it('T91 — relative but unparseable → no date, note explains', () => {
    const r = resolveDelivery(delivery({ kind: 'relative', timeframe: 'whenever is convenient' }), ANCHOR);
    expect(r.date).toBeNull();
    expect(r.basis).toBe('none');
    expect(r.note).toContain('Could not resolve');
  });
  it('T92 — urgency never yields a date, but urgency is carried through', () => {
    const r = resolveDelivery(delivery({ kind: 'urgency', timeframe: 'ASAP', urgency: 'high' }), ANCHOR);
    expect(r.date).toBeNull();
    expect(r.urgency).toBe('high');
    expect(r.timeframe).toBe('ASAP');
  });
  it('T93 — none → no date', () => {
    expect(resolveDelivery(delivery({ kind: 'none' }), ANCHOR).date).toBeNull();
  });
  it('T94 — missing delivery object → treated as none, no date', () => {
    expect(resolveDelivery(undefined, ANCHOR).date).toBeNull();
  });
  it('T95 — evidence and reasoning are preserved for traceability', () => {
    const r = resolveDelivery(delivery({ kind: 'relative', timeframe: '6 weeks', evidence: 'Delivery: 6 weeks ex works', reasoning: 'stated lead time' }), ANCHOR);
    expect(r.evidence).toBe('Delivery: 6 weeks ex works');
    expect(r.reasoning).toBe('stated lead time');
  });
});
