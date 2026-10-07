import { describe, it, expect } from 'vitest';
import { convertToChf } from '../src/fx';

// Rates mirror master_data.json; used inline so tests are self-contained.
const rates = { CHF: 1.0, EUR: 0.96, USD: 0.88, GBP: 1.13 };

describe('convertToChf', () => {
  // ── identity ────────────────────────────────────────────────────────────────

  it('T1 — CHF stays unchanged (rate 1.00)', () => {
    expect(convertToChf(100, 'CHF', rates)).toBe(100.0);
  });

  // ── standard conversions ────────────────────────────────────────────────────

  it('T2 — EUR 100 → CHF 96.00', () => {
    expect(convertToChf(100, 'EUR', rates)).toBe(96.0);
  });

  it('T3 — USD 100 → CHF 88.00', () => {
    expect(convertToChf(100, 'USD', rates)).toBe(88.0);
  });

  it('T4 — GBP 100 → CHF 113.00', () => {
    expect(convertToChf(100, 'GBP', rates)).toBe(113.0);
  });

  // ── rounding (D19: round at total, half-up) ─────────────────────────────────
  // 1.005 × 0.96 = 0.9648 → rounds DOWN to 0.96
  it('T5 — rounds down when sub-cent < 5 (0.9648 → 0.96)', () => {
    expect(convertToChf(1.005, 'EUR', rates)).toBe(0.96);
  });

  // 1.006 × 0.96 = 0.96576 → rounds UP to 0.97
  it('T6 — rounds up when sub-cent ≥ 5 (0.96576 → 0.97)', () => {
    expect(convertToChf(1.006, 'EUR', rates)).toBe(0.97);
  });

  // ── edge cases ───────────────────────────────────────────────────────────────

  it('T7 — zero amount → 0.00', () => {
    expect(convertToChf(0, 'EUR', rates)).toBe(0.0);
  });

  it('T8 — unsupported currency throws', () => {
    expect(() => convertToChf(100, 'JPY', rates)).toThrow('Unsupported currency');
  });
});
