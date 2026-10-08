import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { findBand } from '../src/resolution/approvals';
import type { ApprovalBand } from '../src/schema';

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
