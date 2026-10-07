import { describe, it, expect } from 'vitest';
import { buildApprovalChain, ROLE_LEVEL } from '../src/approvals';
import type { ApprovalBand, CostCentre, Department, Employee } from '../src/schema';

// ── Fixture ──────────────────────────────────────────────────────────────────
//
// CC-A:   owner=EMP-A1 (Alice), dept=DEPT-A → head=EMP-A2 (Bob)
// CC-DUAL: owner=EMP-DUAL (Carol), dept=DEPT-DUAL → head=EMP-DUAL (same person)
//          → the CC-1004/EMP-501 duplicate scenario from master data
//
// Requesters:
//   EMP-REQ  — ordinary requester, never in any chain
//   EMP-A1   — cc_owner of CC-A
//   EMP-A2   — dept_head of DEPT-A
//   EMP-DUAL — both cc_owner (CC-DUAL) and dept_head (DEPT-DUAL)
//   EMP-FIN  — finance
//   EMP-CFO  — CFO
//   EMP-CEO  — CEO

const BANDS: ApprovalBand[] = [
  { from: 0,      to: 1000,   required_roles: ['cost_center_owner'] },
  { from: 1001,   to: 10000,  required_roles: ['cost_center_owner', 'department_head'] },
  { from: 10001,  to: 50000,  required_roles: ['cost_center_owner', 'department_head', 'finance'] },
  { from: 50001,  to: 250000, required_roles: ['cost_center_owner', 'department_head', 'finance', 'cfo'] },
  { from: 250001, to: null,   required_roles: ['cost_center_owner', 'department_head', 'finance', 'cfo', 'ceo'] },
];

const CCS: CostCentre[] = [
  { code: 'CC-A',    name: 'Alpha CC',    owner_employee_id: 'EMP-A1',   department: 'DEPT-A' },
  { code: 'CC-DUAL', name: 'Dual Role CC',owner_employee_id: 'EMP-DUAL', department: 'DEPT-DUAL' },
];

const DEPTS: Department[] = [
  { code: 'DEPT-A',    name: 'Alpha',    head_employee_id: 'EMP-A2' },
  { code: 'DEPT-DUAL', name: 'Dual',     head_employee_id: 'EMP-DUAL' },
];

const EMPS: Employee[] = [
  { id: 'EMP-A1',   name: 'Alice Owner',    email: 'alice@co.com',  role: 'cost_center_owner' },
  { id: 'EMP-A2',   name: 'Bob Head',       email: 'bob@co.com',    role: 'department_head' },
  { id: 'EMP-DUAL', name: 'Carol Dual',     email: 'carol@co.com',  role: 'department_head' },
  { id: 'EMP-FIN',  name: 'Dave Finance',   email: 'dave@co.com',   role: 'finance' },
  { id: 'EMP-CFO',  name: 'Eve CFO',        email: 'eve@co.com',    role: 'cfo' },
  { id: 'EMP-CEO',  name: 'Frank CEO',      email: 'frank@co.com',  role: 'ceo' },
  { id: 'EMP-REQ',  name: 'Grace Req',      email: 'grace@co.com',  role: 'requester_only' },
];

function chain(cc: string, requester: string, chf: number) {
  return buildApprovalChain(cc, requester, chf, BANDS, CCS, DEPTS, EMPS);
}

function ids(result: ReturnType<typeof chain>): string[] {
  if (!result.ok) return [];
  return result.chain.map(s => s.employeeId);
}

// ── Normal chains (no self-approval, no duplicates) ──────────────────────────

describe('normal approval chains (CC-A, requester=EMP-REQ)', () => {
  it('T26 — band 1: [cc_owner]', () => {
    expect(ids(chain('CC-A', 'EMP-REQ', 500))).toEqual(['EMP-A1']);
  });

  it('T27 — band 2: [cc_owner, dept_head]', () => {
    expect(ids(chain('CC-A', 'EMP-REQ', 5000))).toEqual(['EMP-A1', 'EMP-A2']);
  });

  it('T28 — band 3: adds finance', () => {
    expect(ids(chain('CC-A', 'EMP-REQ', 25000))).toEqual(['EMP-A1', 'EMP-A2', 'EMP-FIN']);
  });

  it('T29 — band 4: adds CFO', () => {
    expect(ids(chain('CC-A', 'EMP-REQ', 100000))).toEqual(['EMP-A1', 'EMP-A2', 'EMP-FIN', 'EMP-CFO']);
  });

  it('T30 — band 5: adds CEO', () => {
    expect(ids(chain('CC-A', 'EMP-REQ', 300000))).toEqual(['EMP-A1', 'EMP-A2', 'EMP-FIN', 'EMP-CFO', 'EMP-CEO']);
  });
});

// ── Duplicate collapse ────────────────────────────────────────────────────────

describe('duplicate collapse (CC-DUAL: same person is owner and dept head)', () => {
  it('T31 — band 2: EMP-DUAL appears once', () => {
    expect(ids(chain('CC-DUAL', 'EMP-REQ', 5000))).toEqual(['EMP-DUAL']);
  });

  it('T32 — band 3: [EMP-DUAL, finance]', () => {
    expect(ids(chain('CC-DUAL', 'EMP-REQ', 25000))).toEqual(['EMP-DUAL', 'EMP-FIN']);
  });
});

// ── Self-approval handling ────────────────────────────────────────────────────

describe('self-approval (requester is in the chain)', () => {
  // Band 1: only the cc_owner is required. Requester IS cc_owner. Chain empties → review.
  it('T33 — requester=cc_owner, band 1 → needs_human_review (chain empty)', () => {
    const r = chain('CC-A', 'EMP-A1', 500);
    expect(r.ok).toBe(false);
  });

  // Band 2: [cc_owner, dept_head]. Remove cc_owner (requester). Remaining=[dept_head].
  // dept_head level 2 >= required max 2 → valid.
  it('T34 — requester=cc_owner, band 2 → [dept_head] (covered)', () => {
    const r = chain('CC-A', 'EMP-A1', 5000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chain.map(s => s.employeeId)).toEqual(['EMP-A2']);
  });

  // Band 2: [cc_owner, dept_head]. Remove dept_head (requester). Remaining=[cc_owner].
  // cc_owner level 1 < required max 2 (dept_head) → nobody covers dept_head → review.
  it('T35 — requester=dept_head, band 2 → needs_human_review (cc_owner cannot cover dept_head)', () => {
    const r = chain('CC-A', 'EMP-A2', 5000);
    expect(r.ok).toBe(false);
  });

  // Band 3: [cc_owner, dept_head, finance]. Remove dept_head (requester).
  // Remaining=[cc_owner, finance]. finance level 3 >= required max 3 → valid.
  it('T36 — requester=dept_head, band 3 → [cc_owner, finance] (finance covers)', () => {
    const r = chain('CC-A', 'EMP-A2', 25000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chain.map(s => s.employeeId)).toEqual(['EMP-A1', 'EMP-FIN']);
  });

  // Band 4: [cc_owner, dept_head, finance, cfo]. Remove cfo (requester).
  // Remaining=[cc_owner, dept_head, finance]. finance level 3 < required max 4 → review.
  it('T37 — requester=cfo, band 4 → needs_human_review (finance cannot cover cfo)', () => {
    const r = chain('CC-A', 'EMP-CFO', 100000);
    expect(r.ok).toBe(false);
  });

  // Band 5: ceo must approve. Remove ceo (requester). Remaining max=4 (cfo) < 5 → review.
  it('T38 — requester=ceo, band 5 → needs_human_review (nobody above CEO)', () => {
    const r = chain('CC-A', 'EMP-CEO', 300000);
    expect(r.ok).toBe(false);
  });

  // CC-DUAL after collapse chain=[EMP-DUAL]. Remove EMP-DUAL (requester). Empty → review.
  it('T39 — requester=EMP-DUAL on CC-DUAL, band 2 → needs_human_review (collapsed then emptied)', () => {
    const r = chain('CC-DUAL', 'EMP-DUAL', 5000);
    expect(r.ok).toBe(false);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('unknown cost centre → ok=false', () => {
    const r = chain('CC-UNKNOWN', 'EMP-REQ', 500);
    expect(r.ok).toBe(false);
  });

  it('chain step carries role label', () => {
    const r = chain('CC-A', 'EMP-REQ', 500);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chain[0].role).toBe('cost_center_owner');
  });

  it('ROLE_LEVEL map is consistent (ceo > cfo > finance > dept_head > cc_owner)', () => {
    expect(ROLE_LEVEL.ceo).toBeGreaterThan(ROLE_LEVEL.cfo);
    expect(ROLE_LEVEL.cfo).toBeGreaterThan(ROLE_LEVEL.finance);
    expect(ROLE_LEVEL.finance).toBeGreaterThan(ROLE_LEVEL.department_head);
    expect(ROLE_LEVEL.department_head).toBeGreaterThan(ROLE_LEVEL.cost_center_owner);
  });
});
