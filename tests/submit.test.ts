import { describe, it, expect } from 'vitest';
import { buildPoLines } from '../src/output/submit';
import type { Extraction } from '../src/schema';

// buildPoLines only reads line_items; build a minimal extraction for each case.
function ext(line_items: Extraction['line_items']): Extraction {
  return { line_items } as unknown as Extraction;
}

describe('buildPoLines — PO document lines + total (D30)', () => {
  it('T99 — total is the sum of the lines in the transaction currency (no FX applied)', () => {
    const { lineItems, total } = buildPoLines(ext([
      { description: 'Pump', quantity: 2, unit: 'pcs', unit_price: 4000, price_basis: 'per_unit' },
      { description: 'Seal kit', quantity: 10, unit: 'pcs', unit_price: 90, price_basis: 'per_unit' },
    ]));
    expect(total).toBe(8900);                         // 2*4000 + 10*90 — matches what the ERP sums
    expect(lineItems).toHaveLength(2);
  });

  it('T100 — per_100 basis becomes an effective per-unit price so the line reconciles', () => {
    const { lineItems, total } = buildPoLines(ext([
      { description: 'Washer', quantity: 5000, unit: 'pcs', unit_price: 4.80, price_basis: 'per_100' },
    ]));
    expect(lineItems[0].unit_price).toBeCloseTo(0.048, 6);
    expect(total).toBeCloseTo(240, 2);                // 5000 * 0.048, not 5000 * 4.80
  });

  it('T101 — item_code is carried through when present, omitted when absent', () => {
    const { lineItems } = buildPoLines(ext([
      { description: 'Bearing', quantity: 1, unit: 'pcs', unit_price: 10, price_basis: 'per_unit', item_code: '6204-2RS' },
      { description: 'Custom bracket, as discussed', quantity: 1, unit: 'pcs', unit_price: 20, price_basis: 'per_unit' },
    ]));
    expect(lineItems[0].item_code).toBe('6204-2RS');
    expect(lineItems[1].item_code).toBeUndefined();
  });

  it('T102 — lines missing quantity or price are dropped', () => {
    const { lineItems, total } = buildPoLines(ext([
      { description: 'Priced', quantity: 3, unit: 'pcs', unit_price: 100, price_basis: 'per_unit' },
      { description: 'No price', quantity: 3, unit: 'pcs', unit_price: null, price_basis: null },
    ]));
    expect(lineItems).toHaveLength(1);
    expect(total).toBe(300);
  });
});
