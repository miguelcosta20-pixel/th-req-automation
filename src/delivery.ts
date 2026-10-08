// Deterministic resolution of a delivery requirement into a concrete date.
//
// The LLM classifies the delivery requirement (src/schema.ts DeliverySchema) but
// never computes or invents a date. This module turns that classification into a
// date the SAP PO can carry:
//   - explicit  → the stated calendar date (validated)
//   - relative  → a date computed from the email's own send date + the stated
//                 timeframe ("next week", "6 weeks ex works", "end of month")
//   - urgency   → no date (ASAP/urgent without a timeframe) — never invented
//   - none      → no date
//
// "Never invent": a date only ever comes from an explicit statement or from a
// relative timeframe anchored to the email date. Urgency and silence yield null,
// which routes the requisition to clarification downstream.

import type { Delivery } from './schema';

export interface ResolvedDelivery {
  kind:      'explicit' | 'relative' | 'urgency' | 'none';
  date:      string | null;                       // ISO YYYY-MM-DD for the PO; null when unresolved
  basis:     'explicit' | 'relative' | 'none';    // how `date` was obtained
  urgency:   'high' | 'normal' | 'low' | null;
  timeframe: string | null;                       // the raw phrase, for traceability
  evidence:  string | null;                       // verbatim quote the classification rests on
  reasoning: string | null;                       // the LLM's one-line rationale
  note:      string | null;                       // code-side note on how the date was derived
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// True only for a well-formed, real calendar date in YYYY-MM-DD form
// (rejects "30/06/2026", "2026-13-45", "2026-02-30", etc.).
function isValidIso(s: string | null | undefined): s is string {
  if (!s || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Resolves an extracted delivery classification against the email's send date.
export function resolveDelivery(delivery: Delivery | undefined | null, anchor: Date): ResolvedDelivery {
  const d = delivery ?? { kind: 'none' as const, explicit_date: null, timeframe: null, urgency: null, evidence: null, reasoning: null };
  const carry = {
    kind:      d.kind,
    urgency:   d.urgency ?? null,
    timeframe: d.timeframe ?? null,
    evidence:  d.evidence ?? null,
    reasoning: d.reasoning ?? null,
  };

  if (d.kind === 'explicit' && isValidIso(d.explicit_date)) {
    return { ...carry, date: d.explicit_date, basis: 'explicit', note: null };
  }

  if (d.kind === 'relative') {
    // Prefer the model's resolved date when it is a valid ISO date that is not
    // before the email was sent (the prompt resolves phrases like "Bis Ende Mai"
    // the English-only parser below cannot). The non-past guard catches model
    // resolution slips (e.g. the wrong year).
    const anchorIso = iso(anchor);
    if (isValidIso(d.explicit_date) && d.explicit_date >= anchorIso) {
      return { ...carry, date: d.explicit_date, basis: 'relative', note: `Model-resolved "${d.timeframe ?? ''}" → ${d.explicit_date}` };
    }
    // Otherwise fall back to the deterministic parser on the raw phrase.
    if (d.timeframe) {
      const resolved = resolveRelative(d.timeframe, anchor);
      if (resolved) return { ...carry, date: resolved.date, basis: 'relative', note: resolved.note };
    }
    // Relative but no date could be derived — do not invent one.
    return { ...carry, date: null, basis: 'none', note: d.timeframe ? `Could not resolve "${d.timeframe}" to a concrete date` : 'Relative delivery with no resolvable timeframe' };
  }

  // urgency, none, or an explicit date that failed validation → never invent.
  return { ...carry, date: null, basis: 'none', note: null };
}

// Turns a relative timeframe into a concrete date anchored on `anchor`.
// Returns null for phrases we cannot resolve deterministically (left to a human).
export function resolveRelative(phrase: string, anchor: Date): { date: string; note: string } | null {
  const p = phrase.toLowerCase();

  // Calendar boundary: end of the anchor's month (unambiguous given the anchor).
  if (/end of (the )?month/.test(p)) {
    const eom = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    return { date: iso(eom), note: `"${phrase}" → end of ${anchor.getUTCFullYear()}-${pad(anchor.getUTCMonth() + 1)} (${iso(eom)})` };
  }

  const offset = relativeOffsetDays(p);
  if (offset == null) return null;
  return { date: iso(addDays(anchor, offset)), note: `"${phrase}" → +${offset} days from ${iso(anchor)}` };
}

// Common relative timeframes → an offset in days from the anchor. Conservative:
// anything it cannot map returns null so the requisition goes to clarification.
function relativeOffsetDays(p: string): number | null {
  if (/\btomorrow\b/.test(p)) return 1;
  if (/\bnext week\b/.test(p)) return 7;
  if (/\bnext month\b/.test(p)) return 30;
  // "in 10 days", "within 2 weeks", "after 3 months", bare "6 weeks" / "6-week"
  const m = p.match(/\b(?:in|within|after)?\s*(\d+)[-\s]*(day|week|month)s?\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    return m[2] === 'day' ? n : m[2] === 'week' ? n * 7 : n * 30;
  }
  return null;
}

function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * 86_400_000); }
function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function pad(n: number): string { return String(n).padStart(2, '0'); }
