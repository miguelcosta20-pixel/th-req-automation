import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { findBand } from '../src/resolution/approvals';
import { validateBands, validateSingletonRoles } from '../src/config';
import type { ApprovalBand, Employee } from '../src/schema';

// Boundary cases live in a shared fixture so the demo Rules screen and this test
// assert against exactly the same numbers. The fixture also carries the band
// table (a mirror of master_data.json approval_limits_chf) so the test stays
// self-contained and does not depend on the data file.
interface ApprovalCase {
  total: number;
  expected_band: number;
  expected_role_count: number;
  note: string;
}
interface ApprovalFixture {
  bands: ApprovalBand[];
  cases: ApprovalCase[];
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fixture: ApprovalFixture = JSON.parse(
  readFileSync(resolve(fixtureDir, 'fixtures/approval-cases.json'), 'utf-8'),
);
const BANDS = fixture.bands;

describe('findBand — boundary cases from tests/fixtures/approval-cases.json', () => {
  for (const c of fixture.cases) {
    it(`${c.total} → band ${c.expected_band} (${c.note})`, () => {
      const band = findBand(c.total, BANDS);
      expect(band.required_roles.length).toBe(c.expected_role_count);
      // Band identity: the matched band is the expected_band-th when sorted by ceiling.
      const sorted = [...BANDS].sort((a, b) => (a.to ?? Infinity) - (b.to ?? Infinity));
      expect(sorted.indexOf(band) + 1).toBe(c.expected_band);
    });
  }

  // ── returns the correct object, not just a count ─────────────────────────────

  it('band 1 result has role cost_center_owner', () => {
    expect(findBand(500, BANDS).required_roles).toEqual(['cost_center_owner']);
  });

  it('band 5 result includes ceo', () => {
    expect(findBand(300_000, BANDS).required_roles).toContain('ceo');
  });
});

// ── validateBands ────────────────────────────────────────────────────────────

describe('validateBands — startup integrity check', () => {
  it('passes for the fixture bands (the real master data shape)', () => {
    expect(() => validateBands(BANDS)).not.toThrow();
  });

  it('throws when the list is empty', () => {
    expect(() => validateBands([])).toThrow(/at least one band/);
  });

  it('throws when a non-last band has to: null', () => {
    const bands: ApprovalBand[] = [
      { from: 0,    to: null, required_roles: ['cost_center_owner'] },
      { from: 1001, to: null, required_roles: ['cost_center_owner', 'department_head'] },
    ];
    expect(() => validateBands(bands)).toThrow(/not the last band/);
  });

  it('throws when bands are out of order', () => {
    const bands: ApprovalBand[] = [
      { from: 5001, to: 10000, required_roles: ['cost_center_owner', 'department_head'] },
      { from: 0,    to: 1000,  required_roles: ['cost_center_owner'] },
    ];
    expect(() => validateBands(bands)).toThrow(/not ordered/);
  });

  it('throws when two consecutive bands overlap', () => {
    const bands: ApprovalBand[] = [
      { from: 0,    to: 2000,  required_roles: ['cost_center_owner'] },
      { from: 1500, to: 10000, required_roles: ['cost_center_owner', 'department_head'] },
    ];
    expect(() => validateBands(bands)).toThrow(/overlap/);
  });

  it('throws when a band has from > to', () => {
    const bands: ApprovalBand[] = [
      { from: 500, to: 100, required_roles: ['cost_center_owner'] },
    ];
    expect(() => validateBands(bands)).toThrow(/from.*>.*to/);
  });
});

// ── validateSingletonRoles ────────────────────────────────────────────────────

function emp(id: string, role: Employee['role'], deputyFor?: string): Employee {
  return { id, name: id, email: `${id}@co.com`, role, ...(deputyFor ? { deputy_for: deputyFor } : {}) };
}

const GOOD_EMPLOYEES: Employee[] = [
  emp('FIN',  'finance'),
  emp('CFO',  'cfo'),
  emp('CEO',  'ceo'),
  emp('DEP',  'finance', 'FIN'), // deputy — excluded from primary count
];

describe('validateSingletonRoles — startup integrity check', () => {
  it('passes for a valid set (one primary per singleton role)', () => {
    expect(() => validateSingletonRoles(GOOD_EMPLOYEES)).not.toThrow();
  });

  it('throws when finance is missing', () => {
    const employees = GOOD_EMPLOYEES.filter(e => e.id !== 'FIN');
    expect(() => validateSingletonRoles(employees)).toThrow(/finance/);
  });

  it('throws when there are two primary CFOs', () => {
    const employees = [...GOOD_EMPLOYEES, emp('CFO2', 'cfo')];
    expect(() => validateSingletonRoles(employees)).toThrow(/cfo/);
  });

  it('does not count a deputy as a primary', () => {
    // DEP is a finance deputy; with FIN present that is still exactly one primary finance.
    expect(() => validateSingletonRoles(GOOD_EMPLOYEES)).not.toThrow();
  });
});
