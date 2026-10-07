import Fuse from 'fuse.js';
import type { Supplier, CostCentre, Employee } from './schema';

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

function toResult<T>(results: Fuse.FuseResult<T>[]): ResolveResult<T> {
  if (results.length === 0) {
    return { match: null, score: 0, ambiguous: false };
  }

  const topFuse = results[0].score ?? 1;
  const score = 1 - topFuse;

  let ambiguous = false;
  if (results.length >= 2) {
    const secondFuse = results[1].score ?? 1;
    // Both are within MATCH_THRESHOLD (guaranteed by fuse); ambiguous if close.
    ambiguous = secondFuse - topFuse < AMBIGUITY_GAP;
  }

  return { match: results[0].item, score, ambiguous };
}
