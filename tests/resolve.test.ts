import { readFileSync } from 'fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { MasterDataSchema } from '../src/schema';
import { resolveSupplier, resolveCostCentre, resolveEmployee, resolveGlAccount } from '../src/resolution/resolve';
import type { MasterData } from '../src/schema';

// Real master data — resolve tests exercise the actual data quality issues
// (near-duplicate suppliers, German alias hints, unknown codes, blocked status).
let md: MasterData;

beforeAll(() => {
  md = MasterDataSchema.parse(
    JSON.parse(readFileSync('./data/master_data.json', 'utf-8')),
  );
});

// ── Supplier resolution ───────────────────────────────────────────────────────

describe('resolveSupplier', () => {
  it('T40 — exact name → SUP-001, score near 1, not ambiguous', () => {
    const r = resolveSupplier('Acme Bearings GmbH', md.suppliers);
    expect(r.match?.id).toBe('SUP-001');
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.ambiguous).toBe(false);
  });

  it('T41 — case-insensitive: "acme bearings gmbh" → SUP-001', () => {
    const r = resolveSupplier('acme bearings gmbh', md.suppliers);
    expect(r.match?.id).toBe('SUP-001');
  });

  it('T42 — partial "Acme Bearings" → SUP-001, not ambiguous', () => {
    const r = resolveSupplier('Acme Bearings', md.suppliers);
    expect(r.match?.id).toBe('SUP-001');
    expect(r.ambiguous).toBe(false);
  });

  it('T43 — "Acme Bearing" → ambiguous (both SUP-001 and SUP-006 are partial matches)', () => {
    // "Acme Bearing" is the common stem: both "Acme Bearings GmbH" and "ACME Bearing Group Ltd"
    // match nearly equally — neither discriminating suffix (GmbH vs Group Ltd) is present.
    const r = resolveSupplier('Acme Bearing', md.suppliers);
    expect(r.ambiguous).toBe(true);
  });

  it('T44 — "Industriebedarf" → ambiguous (SUP-004 Müller vs SUP-007 Mueller, shared word)', () => {
    // Both contain "Industriebedarf" exactly; fuse scores nearly identical → ambiguous.
    const r = resolveSupplier('Industriebedarf', md.suppliers);
    expect(r.ambiguous).toBe(true);
  });

  it('T45 — blocked supplier resolves but status is blocked', () => {
    const r = resolveSupplier('Baltic Steel Trading', md.suppliers);
    expect(r.match?.id).toBe('SUP-018');
    expect(r.match?.status).toBe('blocked');
  });

  it('T46 — unknown supplier → no match', () => {
    const r = resolveSupplier('Unknown Vendor GmbH XYZ123', md.suppliers);
    expect(r.match).toBeNull();
  });
});

// ── Cost centre resolution ────────────────────────────────────────────────────

describe('resolveCostCentre', () => {
  it('T47 — exact code "CC-1001" → CC-1001', () => {
    const r = resolveCostCentre('CC-1001', md.cost_centers);
    expect(r.match?.code).toBe('CC-1001');
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('T48 — full name "Plant Maintenance Schorndorf" → CC-1001', () => {
    const r = resolveCostCentre('Plant Maintenance Schorndorf', md.cost_centers);
    expect(r.match?.code).toBe('CC-1001');
  });

  it('T49 — partial hint "Toolroom" → CC-1004 (Toolroom & Fixtures)', () => {
    const r = resolveCostCentre('Toolroom', md.cost_centers);
    expect(r.match?.code).toBe('CC-1004');
  });

  it('T50 — unknown code "CC-9100" → no match', () => {
    const r = resolveCostCentre('CC-9100', md.cost_centers);
    expect(r.match).toBeNull();
  });

  it('T51 — "Production Line" → ambiguous (CC-1002 "…Line A" and CC-1003 "…Line B" both match)', () => {
    const r = resolveCostCentre('Production Line', md.cost_centers);
    expect(r.ambiguous).toBe(true);
  });
});

// ── Employee resolution ───────────────────────────────────────────────────────

describe('resolveEmployee', () => {
  it('T52 — exact email → EMP-101 (Hans Meier), high score', () => {
    const r = resolveEmployee('hans.meier@customer.com', md.employees);
    expect(r.match?.id).toBe('EMP-101');
    expect(r.score).toBeGreaterThan(0.8);
  });

  it('T53 — fuzzy name "Hans Meier" → EMP-101', () => {
    const r = resolveEmployee('Hans Meier', md.employees);
    expect(r.match?.id).toBe('EMP-101');
  });

  it('T54 — unknown external email → no match', () => {
    const r = resolveEmployee('unknown@external.com', md.employees);
    expect(r.match).toBeNull();
  });
});

// ── GL account determination (category → GL) ──────────────────────────────────

describe('resolveGlAccount', () => {
  it('T54a — "packaging" → 7500 Packaging Material, unambiguous', () => {
    const r = resolveGlAccount('packaging', md.gl_accounts);
    expect(r.match?.code).toBe('7500');
    expect(r.ambiguous).toBe(false);
  });

  it('T54b — "office supplies" → 7100 Office Supplies', () => {
    const r = resolveGlAccount('office supplies', md.gl_accounts);
    expect(r.match?.code).toBe('7100');
  });

  it('T54c — "spare parts" → 5300 Spare Parts', () => {
    const r = resolveGlAccount('spare parts', md.gl_accounts);
    expect(r.match?.code).toBe('5300');
  });

  it('T54d — gibberish category → no match (left for ERP)', () => {
    const r = resolveGlAccount('zzzzz nonsense xyz', md.gl_accounts);
    expect(r.match).toBeNull();
  });
});
