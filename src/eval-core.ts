// Reusable evaluation logic shared by the CLI (src/eval.ts) and the demo
// Quality screen (src/demo.ts). This module knows how to load the labelled
// emails, run the real pipeline on one, score the result field-by-field, and
// aggregate the metrics. It writes no files and prints nothing — the callers
// decide how to present the results.

import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { LlmClient } from './llm/client';
import type { AppConfig } from './config';
import type { ProcessResult } from './types';
import { processEml } from './pipeline';

// ── Label schema ────────────────────────────────────────────────────────────

export const LabelSchema = z.object({
  email_file:  z.string(),
  description: z.string(),
  expected: z.object({
    status:             z.enum(['waiting_approval', 'needs_clarification', 'needs_human_review', 'security', 'failed']),
    supplier_id:        z.string().nullable(),
    cost_centre_code:   z.string().nullable(),
    currency:           z.string().nullable(),
    has_delivery_date:  z.boolean().nullable(),
    min_line_items:     z.number().nullable(),
    total_chf_range:    z.tuple([z.number(), z.number()]).nullable(),
    approval_chain_ids: z.array(z.string()).nullable(),
  }),
  verify_after_run: z.boolean().default(false),
  notes:            z.string().optional(),
});

export type EvalLabel = z.infer<typeof LabelSchema>;

// ── Per-field check ───────────────────────────────────────────────────────────

export interface FieldCheck {
  field:    string;
  expected: string;
  actual:   string;
  pass:     boolean;
  skipped:  boolean;
}

// Scores a single pipeline result against its label. 'status' is always checked;
// every other field is skipped when the label sets it to null.
export function checkLabel(label: EvalLabel, result: ProcessResult): FieldCheck[] {
  const e = label.expected;
  const checks: FieldCheck[] = [];

  const check = (
    field:    string,
    expected: string | null,
    actual:   string | undefined,
    pass:     boolean,
  ) => {
    if (expected === null) {
      checks.push({ field, expected: '(skip)', actual: actual ?? '—', pass: true, skipped: true });
    } else {
      checks.push({ field, expected, actual: actual ?? '—', pass, skipped: false });
    }
  };

  checks.push({
    field:    'status',
    expected: e.status,
    actual:   result.status,
    pass:     result.status === e.status,
    skipped:  false,
  });

  check('supplier_id', e.supplier_id,      result.supplierId,     result.supplierId === e.supplier_id);
  check('cost_centre', e.cost_centre_code, result.costCentreCode, result.costCentreCode === e.cost_centre_code);
  check('currency',    e.currency,         result.currency,       result.currency === e.currency);

  if (e.has_delivery_date !== null) {
    check('delivery_date', String(e.has_delivery_date), String(result.hasDeliveryDate ?? false),
      result.hasDeliveryDate === e.has_delivery_date);
  } else {
    check('delivery_date', null, undefined, true);
  }

  if (e.min_line_items !== null) {
    const actual = result.lineItemCount ?? 0;
    check('line_items', `>=${e.min_line_items}`, String(actual), actual >= e.min_line_items);
  } else {
    check('line_items', null, undefined, true);
  }

  if (e.total_chf_range !== null) {
    const [min, max] = e.total_chf_range;
    const actual     = result.totalChf ?? 0;
    check('total_chf', `${min}–${max}`, actual.toFixed(2), actual >= min && actual <= max);
  } else {
    check('total_chf', null, undefined, true);
  }

  if (e.approval_chain_ids !== null) {
    const actual = result.approvalChainIds ?? [];
    const pass   = JSON.stringify(actual) === JSON.stringify(e.approval_chain_ids);
    check('chain', e.approval_chain_ids.join(','), actual.join(','), pass);
  } else {
    check('chain', null, undefined, true);
  }

  return checks;
}

// ── Loading & running ──────────────────────────────────────────────────────────

export interface LabelEntry {
  id:    string;
  label: EvalLabel;
}

// Loads and validates every label file in eval/labels/, sorted by id (E01, E02…).
export function loadLabels(labelsDir: string): LabelEntry[] {
  return readdirSync(labelsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({
      id:    f.replace('.json', ''),
      label: LabelSchema.parse(JSON.parse(readFileSync(join(labelsDir, f), 'utf-8'))),
    }));
}

export interface EvalRow {
  id:            string;
  label:         EvalLabel;
  result:        ProcessResult;
  checks:        FieldCheck[];
  latencyMs:     number;
  error?:        string;
  falseApproval: boolean;
}

export interface EvalDeps {
  db:     Database.Database;
  client: LlmClient;
  config: AppConfig;
}

// Runs the real pipeline on one labelled email and scores it. Never throws:
// a pipeline exception becomes a 'failed' result so a batch run can continue.
export async function runLabel(entry: LabelEntry, deps: EvalDeps): Promise<EvalRow> {
  const emailPath = resolve(process.cwd(), entry.label.email_file);
  const t0 = Date.now();

  let result: ProcessResult;
  let error: string | undefined;
  try {
    result = await processEml(emailPath, deps);
  } catch (err) {
    result = { status: 'failed', emailPath, error: String(err) };
    error  = String(err);
  }

  const latencyMs = Date.now() - t0;
  const checks    = checkLabel(entry.label, result);

  // Pipeline no longer auto-submits; false_approval is not possible at this stage.
  const falseApproval = false;

  return { id: entry.id, label: entry.label, result, checks, latencyMs, error, falseApproval };
}

// ── Aggregate metrics ──────────────────────────────────────────────────────────

export interface EvalMetrics {
  n:              number;
  statusMatches:  number;
  fieldPass:      number;
  fieldTotal:     number;
  falseApprovals: number;
  reviewShare:    number;
  avgLatencyMs:   number;
  totalCostChf:   number;
  unverified:     number;
}

export function aggregate(rows: EvalRow[]): EvalMetrics {
  const n = rows.length;
  const statusMatches = rows.filter(r => r.checks.find(c => c.field === 'status')?.pass).length;
  const reviewShare = rows.filter(r =>
    r.result.status === 'needs_human_review' ||
    r.result.status === 'needs_clarification' ||
    r.result.status === 'security',
  ).length;

  const allChecks  = rows.flatMap(r => r.checks.filter(c => !c.skipped && c.field !== 'status'));
  const fieldPass  = allChecks.filter(c => c.pass).length;

  return {
    n,
    statusMatches,
    fieldPass,
    fieldTotal:     allChecks.length,
    falseApprovals: rows.filter(r => r.falseApproval).length,
    reviewShare,
    avgLatencyMs:   n === 0 ? 0 : rows.reduce((s, r) => s + r.latencyMs, 0) / n,
    totalCostChf:   0,
    unverified:     rows.filter(r => r.label.verify_after_run).length,
  };
}

export function pct(n: number, d: number): string {
  return d === 0 ? '0' : Math.round((n / d) * 100).toString();
}
