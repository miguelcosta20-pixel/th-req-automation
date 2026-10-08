import type { ApprovalBand, CostCentre, Department, Employee, Rules } from '../schema';


export interface ApprovalStep {
  employeeId: string;
  name: string;
  email: string;
  role: string;
  // Set when this approver is also the requester. Self-approval is forbidden, so
  // the step is kept (not dropped) and flagged for a human to assign an alternate.
  requiresAlternate?: boolean;
}

export type ChainResult =
  | { ok: true; chain: ApprovalStep[] }
  // On failure we still return the chain when we have one, so the UI can show the
  // flagged steps (e.g. a requester-is-approver conflict) rather than nothing.
  | { ok: false; reason: string; chain?: ApprovalStep[] };

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
//   3. Collapse duplicates when rules.duplicate_role_collapses is true — same
//      person holding two roles appears once, promoted to the higher role.
//   4. Self-approval (A6 / D27) when rules.self_approval_forbidden is true: if
//      the requester is one of the required approvers, keep that step but flag it
//      requiresAlternate and fail the chain. requesterEmployeeId may be null when
//      the requester is not in master data (external sender); in that case the
//      self-approval check is skipped — there is no ID to compare against.
export function buildApprovalChain(
  costCentreCode:      string,
  requesterEmployeeId: string | null,
  totalChf:            number,
  bands:               ApprovalBand[],
  costCentres:         CostCentre[],
  departments:         Department[],
  employees:           Employee[],
  rules:               Rules,
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
  // low→high), update their chain entry to the last (highest) role seen.
  // Skipped when rules.duplicate_role_collapses is false — each role step is kept.
  const seenIdx = new Map<string, number>();
  const chain: ApprovalStep[] = [];
  for (const step of rawSteps) {
    const idx = seenIdx.get(step.employeeId);
    if (idx !== undefined && rules.duplicate_role_collapses) {
      chain[idx] = step; // promote to higher role
    } else {
      seenIdx.set(step.employeeId, chain.length);
      chain.push(step);
    }
  }

  // Self-approval conflict: the requester is one of the required approvers.
  // Skipped when rules.self_approval_forbidden is false, or when requesterEmployeeId
  // is null (requester not in master data — no ID to compare against).
  if (rules.self_approval_forbidden && requesterEmployeeId !== null) {
    const requesterIdx = chain.findIndex(s => s.employeeId === requesterEmployeeId);
    if (requesterIdx !== -1) {
      const flaggedChain = chain.map((s, i) =>
        i === requesterIdx ? { ...s, requiresAlternate: true } : s);
      const roleHuman = chain[requesterIdx].role.replace(/_/g, ' ');
      return {
        ok: false,
        reason: `Requester is also the ${roleHuman} for this cost centre — an alternate approver is required`,
        chain: flaggedChain,
      };
    }
  }

  return { ok: true, chain };
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
