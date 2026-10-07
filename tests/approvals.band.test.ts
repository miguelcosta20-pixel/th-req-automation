import { describe, it, expect } from 'vitest';
import { findBand } from '../src/approvals';
import type { ApprovalBand } from '../src/schema';

// Mirror of master_data.json approval_limits_chf, kept inline for self-contained tests.
const BANDS: ApprovalBand[] = [
  { from: 0,      to: 1000,   required_roles: ['cost_center_owner'] },
  { from: 1001,   to: 10000,  required_roles: ['cost_center_owner', 'department_head'] },
  { from: 10001,  to: 50000,  required_roles: ['cost_center_owner', 'department_head', 'finance'] },
  { from: 50001,  to: 250000, required_roles: ['cost_center_owner', 'department_head', 'finance', 'cfo'] },
  { from: 250001, to: null,   required_roles: ['cost_center_owner', 'department_head', 'finance', 'cfo', 'ceo'] },
];

// Helper: total → number of required roles (a proxy for "which band")
function rolesCount(total: number): number {
  return findBand(total, BANDS).required_roles.length;
}

describe('findBand', () => {
  // ── band 1: 0 – 1000 (cc_owner only) ───────────────────────────────────────

  it('T9  — 0 → band 1', () => expect(rolesCount(0)).toBe(1));
  it('T10 — 500 → band 1', () => expect(rolesCount(500)).toBe(1));
  it('T11 — 1000.00 → band 1 (exactly at ceiling)', () => expect(rolesCount(1000.0)).toBe(1));

  // ── gap 1000.01 – 1000.99: between band 1 ceiling and band 2 floor ─────────
  // D18: first band whose ceiling the total does not exceed → next band up.

  it('T12 — 1000.01 → band 2 (gap: > band 1 ceiling, < band 2 floor)', () =>
    expect(rolesCount(1000.01)).toBe(2));
  it('T13 — 1000.50 → band 2 (the A1 example gap)', () =>
    expect(rolesCount(1000.5)).toBe(2));
  it('T14 — 1000.99 → band 2 (gap)', () => expect(rolesCount(1000.99)).toBe(2));

  // ── band 2: 1001 – 10000 ────────────────────────────────────────────────────

  it('T15 — 1001.00 → band 2', () => expect(rolesCount(1001)).toBe(2));
  it('T16 — 10000.00 → band 2 (ceiling)', () => expect(rolesCount(10000)).toBe(2));

  // ── gap and band 3 ──────────────────────────────────────────────────────────

  it('T17 — 10000.01 → band 3 (gap)', () => expect(rolesCount(10000.01)).toBe(3));
  it('T18 — 10001.00 → band 3', () => expect(rolesCount(10001)).toBe(3));
  it('T19 — 50000.00 → band 3 (ceiling)', () => expect(rolesCount(50000)).toBe(3));

  // ── gap and band 4 ──────────────────────────────────────────────────────────

  it('T20 — 50000.01 → band 4 (gap)', () => expect(rolesCount(50000.01)).toBe(4));
  it('T21 — 50001.00 → band 4', () => expect(rolesCount(50001)).toBe(4));
  it('T22 — 250000.00 → band 4 (ceiling)', () => expect(rolesCount(250000)).toBe(4));

  // ── gap and band 5 (null ceiling = ∞) ───────────────────────────────────────

  it('T23 — 250000.01 → band 5 (gap)', () => expect(rolesCount(250000.01)).toBe(5));
  it('T24 — 250001.00 → band 5', () => expect(rolesCount(250001)).toBe(5));
  it('T25 — 1_000_000 → band 5', () => expect(rolesCount(1_000_000)).toBe(5));

  // ── returns the correct object, not just count ──────────────────────────────

  it('band 1 result has role cost_center_owner', () => {
    expect(findBand(500, BANDS).required_roles).toEqual(['cost_center_owner']);
  });

  it('band 5 result includes ceo', () => {
    expect(findBand(300_000, BANDS).required_roles).toContain('ceo');
  });
});
