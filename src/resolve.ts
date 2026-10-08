import Fuse, { type FuseResult } from 'fuse.js';
import type { Supplier, CostCentre, Employee, MasterData, Extraction } from './schema';
import { convertToChf } from './fx';
import { buildApprovalChain } from './approvals';
import type { ChainResult } from './approvals';
import { resolveDelivery } from './delivery';
import type { ResolvedDelivery } from './delivery';

// Fuse threshold: only return results with score <= this (0=perfect, 1=no match).
// 0.3 is tight enough to reject codes with a few digit differences (CC-9100 ≠ CC-1001)
// while still catching partial and fuzzy name matches.
const MATCH_THRESHOLD = 0.3;

// Two returned results are ambiguous when the gap between their scores is narrow.
// Because fuse already filters to <= 0.3, both results are "good" — the gap alone
// determines whether one is a clear winner.
const AMBIGUITY_GAP = 0.15;

export interface ResolveResult<T> {
  match: T | null;
  // 1.0 = perfect, 0.0 = no match (inverted from fuse's internal 0=perfect scale)
  score: number;
  ambiguous: boolean;
}

export interface FullResolution {
  supplier:         ResolveResult<Supplier> | null;
  costCentre:       ResolveResult<CostCentre> | null;
  employee:         ResolveResult<Employee> | null;
  currency:         string;
  fxRate:           number;
  computedTotalChf: number;
  chain:            ChainResult | null;
  delivery:         ResolvedDelivery;
}

export function resolveSupplier(hint: string, suppliers: Supplier[]): ResolveResult<Supplier> {
  const fuse = new Fuse(suppliers, {
    keys: ['name'],
    threshold: MATCH_THRESHOLD,
    includeScore: true,
    isCaseSensitive: false,
  });
  return toResult(fuse.search(hint));
}

export function resolveCostCentre(hint: string, costCentres: CostCentre[]): ResolveResult<CostCentre> {
  // Exact code match first — codes are identifiers, not candidates for fuzzy.
  // "CC-9100" must NOT fuzzily match "CC-1001"; exact-or-nothing is correct here.
  const exact = costCentres.find(c => c.code.toLowerCase() === hint.toLowerCase());
  if (exact) {
    return { match: exact, score: 1.0, ambiguous: false };
  }

  // Fall back to fuzzy name match for natural-language hints ("Plant Maintenance", "Linie A").
  const fuse = new Fuse(costCentres, {
    keys: ['name'],
    threshold: MATCH_THRESHOLD,
    includeScore: true,
    isCaseSensitive: false,
  });
  return toResult(fuse.search(hint));
}

export function resolveEmployee(hint: string, employees: Employee[]): ResolveResult<Employee> {
  const fuse = new Fuse(employees, {
    keys: ['name', 'email'],
    threshold: MATCH_THRESHOLD,
    includeScore: true,
    isCaseSensitive: false,
  });
  return toResult(fuse.search(hint));
}

// Resolves all master-data references for a single extraction and computes
// the approval chain. Used by the pipeline to produce a FullResolution for
// decide() and submit(). `anchorDate` is the email's send date — relative
// delivery timeframes ("next week") are resolved against it, and `defaultLeadDays`
// lets an explicitly flexible request fall back to a standard lead time.
export function resolveRequisition(extraction: Extraction, masterData: MasterData, anchorDate: Date, defaultLeadDays?: number): FullResolution {
  const currency = extraction.currency ?? 'CHF';
  const fxRate   = masterData._meta.fx_rates_to_chf[currency] ?? 1;

  const supplier    = extraction.supplier_name
    ? resolveSupplier(extraction.supplier_name, masterData.suppliers)
    : null;

  const costCentre  = extraction.cost_centre_hint
    ? resolveCostCentre(extraction.cost_centre_hint, masterData.cost_centers)
    : null;

  const employee    = extraction.requester_email
    ? resolveEmployee(extraction.requester_email, masterData.employees)
    : null;

  // Compute raw total from line items (before FX conversion).
  const rawTotal = (extraction.line_items ?? []).reduce((sum, item) => {
    if (item.quantity == null || item.unit_price == null) return sum;
    // price_basis 'per_100' means the unit_price is per 100 units, not per 1.
    const factor = item.price_basis === 'per_100' ? 1 / 100 : 1;
    return sum + item.quantity * item.unit_price * factor;
  }, 0);

  const computedTotalChf = convertToChf(rawTotal, currency, masterData._meta.fx_rates_to_chf);

  // Build approval chain when we have a resolved cost centre.
  let chain: ChainResult | null = null;
  if (costCentre?.match) {
    const requesterEmpId = employee?.match?.id ?? '';
    chain = buildApprovalChain(
      costCentre.match.code,
      requesterEmpId,
      computedTotalChf,
      masterData.approval_limits_chf,
      masterData.cost_centers,
      masterData.departments,
      masterData.employees,
    );
  }

  return { supplier, costCentre, employee, currency, fxRate, computedTotalChf, chain, delivery: resolveDelivery(extraction.delivery, anchorDate, defaultLeadDays) };
}

function toResult<T>(results: FuseResult<T>[]): ResolveResult<T> {
  if (results.length === 0) {
    return { match: null, score: 0, ambiguous: false };
  }

  const topFuse = results[0].score ?? 1;
  const score   = 1 - topFuse;

  let ambiguous = false;
  if (results.length >= 2) {
    const secondFuse = results[1].score ?? 1;
    // Both are within MATCH_THRESHOLD (guaranteed by fuse); ambiguous if close.
    ambiguous = secondFuse - topFuse < AMBIGUITY_GAP;
  }

  return { match: results[0].item, score, ambiguous };
}
