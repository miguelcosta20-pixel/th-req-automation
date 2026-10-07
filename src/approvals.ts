import type { ApprovalBand, CostCentre, Department, Employee } from './schema';

// Role hierarchy for coverage checks. Higher number = higher authority.
export const ROLE_LEVEL: Record<string, number> = {
  cost_center_owner: 1,
  department_head: 2,
  finance: 3,
  cfo: 4,
  ceo: 5,
};

export interface ApprovalStep {
  employeeId: string;
  name: string;
  email: string;
  role: string;
}

export type ChainResult =
  | { ok: true; chain: ApprovalStep[] }
  | { ok: false; reason: string };

// Finds the approval band for a given CHF total.
//
// Gap decision (D18, resolves A1): master data bands use integer from/to
// (e.g. band 1 ends at 1000, band 2 starts at 1001). A fractional total like
// 1000.50 falls in neither. Rule: sort bands by ceiling (to) ascending, null=∞,
// and return the first band whose ceiling the total does not exceed. This assigns
// gap values to the next band up — the conservative choice. The 'from' field is
// never used for lookup; it is documentation of intent only.
export function findBand(totalChf: number, bands: ApprovalBand[]): ApprovalBand {
  const sorted = [...bands].sort((a, b) => (a.to ?? Infinity) - (b.to ?? Infinity));
  const band = sorted.find(b => totalChf <= (b.to ?? Infinity));
  if (!band) {
    throw new Error(`No approval band found for total CHF ${totalChf}`);
  }
  return band;
}

// Builds the ordered approval chain for a requisition.
//
// Steps:
//   1. Find the band for the CHF total.
//   2. Resolve each required role to a real person; fail if any is unresolvable.
//   3. Collapse duplicates — same person holding two roles appears once (D rules).
//   4. Remove the requester (self-approval forbidden, D rules).
//   5. Coverage check (D20): the highest role level remaining in the chain must
//      be >= the highest role level required by the band. A person at level N
//      implicitly covers all levels below N. If coverage fails → needs_human_review.
export function buildApprovalChain(
  costCentreCode: string,
  requesterEmployeeId: string,
  totalChf: number,
  bands: ApprovalBand[],
  costCentres: CostCentre[],
  departments: Department[],
  employees: Employee[],
): ChainResult {
  const band = findBand(totalChf, bands);

  // Resolve roles to people
  const rawSteps: ApprovalStep[] = [];
  for (const role of band.required_roles) {
    const emp = resolvePersonForRole(role, costCentreCode, costCentres, departments, employees);
    if (!emp) {
      return {
        ok: false,
        reason: `Cannot resolve role "${role}" for cost centre "${costCentreCode}"`,
      };
    }
    rawSteps.push({ employeeId: emp.id, name: emp.name, email: emp.email, role });
  }

  // Collapse: if the same person holds two required roles (required_roles is ordered
  // low→high), update their chain entry to the last (highest) role seen so the
  // coverage check sees the correct level.
  const seenIdx = new Map<string, number>();
  const chain: ApprovalStep[] = [];
  for (const step of rawSteps) {
    const idx = seenIdx.get(step.employeeId);
    if (idx !== undefined) {
      chain[idx] = step; // promote to higher role
    } else {
      seenIdx.set(step.employeeId, chain.length);
      chain.push(step);
    }
  }

  // Remove requester
  const withoutRequester = chain.filter(s => s.employeeId !== requesterEmployeeId);

  // Coverage check: max level remaining must >= max level required
  const requiredMaxLevel = band.required_roles.reduce(
    (max, role) => Math.max(max, ROLE_LEVEL[role] ?? 0),
    0,
  );
  const remainingMaxLevel = withoutRequester.reduce(
    (max, step) => Math.max(max, ROLE_LEVEL[step.role] ?? 0),
    Number.NEGATIVE_INFINITY,
  );

  if (remainingMaxLevel < requiredMaxLevel) {
    return {
      ok: false,
      reason:
        `Requester ${requesterEmployeeId} is in the approval chain; ` +
        `remaining max level ${remainingMaxLevel} < required ${requiredMaxLevel}`,
    };
  }

  return { ok: true, chain: withoutRequester };
}

function resolvePersonForRole(
  role: string,
  costCentreCode: string,
  costCentres: CostCentre[],
  departments: Department[],
  employees: Employee[],
): Employee | undefined {
  const cc = costCentres.find(c => c.code === costCentreCode);

  switch (role) {
    case 'cost_center_owner': {
      if (!cc) return undefined;
      return employees.find(e => e.id === cc.owner_employee_id);
    }
    case 'department_head': {
      if (!cc) return undefined;
      const dept = departments.find(d => d.code === cc.department);
      if (!dept) return undefined;
      return employees.find(e => e.id === dept.head_employee_id);
    }
    case 'finance': {
      // Primary finance person; deputies have deputy_for set
      return employees.find(e => e.role === 'finance' && e.deputy_for === undefined);
    }
    case 'cfo': {
      return employees.find(e => e.role === 'cfo');
    }
    case 'ceo': {
      return employees.find(e => e.role === 'ceo');
    }
    default:
      return undefined;
  }
}
