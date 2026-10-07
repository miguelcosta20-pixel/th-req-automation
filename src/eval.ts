// Evaluation harness: runs the pipeline on 15 labeled emails and writes
// docs/eval.md with per-email results, aggregated metrics, and a failure log.
//
// Run:  npm run eval
// Prerequisite: ANTHROPIC_API_KEY must be set in .env

import 'dotenv/config';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { z } from 'zod';
import { initDb } from './db.js';
import { loadConfig } from './config.js';
import { AnthropicClient } from './llm/anthropic.js';
import { processEml } from './pipeline.js';
import type { ProcessResult } from './types.js';

// ── Label schema ──────────────────────────────────────────────────────────────

const LabelSchema = z.object({
  email_file:       z.string(),
  description:      z.string(),
  expected: z.object({
    status:              z.enum(['submitted', 'needs_clarification', 'needs_human_review', 'security', 'failed']),
    supplier_id:         z.string().nullable(),
    cost_centre_code:    z.string().nullable(),
    currency:            z.string().nullable(),
    has_delivery_date:   z.boolean().nullable(),
    min_line_items:      z.number().nullable(),
    total_chf_range:     z.tuple([z.number(), z.number()]).nullable(),
    approval_chain_ids:  z.array(z.string()).nullable(),
  }),
  verify_after_run: z.boolean().default(false),
  notes:            z.string().optional(),
});

type EvalLabel = z.infer<typeof LabelSchema>;

// ── Per-field check ───────────────────────────────────────────────────────────

interface FieldCheck {
  field:    string;
  expected: string;
  actual:   string;
  pass:     boolean;
  skipped:  boolean;
}

function checkLabel(label: EvalLabel, result: ProcessResult): FieldCheck[] {
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

  // Status is always checked.
  checks.push({
    field:    'status',
    expected: e.status,
    actual:   result.status,
    pass:     result.status === e.status,
    skipped:  false,
  });

  check('supplier_id',     e.supplier_id,      result.supplierId,     result.supplierId === e.supplier_id);
  check('cost_centre',     e.cost_centre_code, result.costCentreCode, result.costCentreCode === e.cost_centre_code);
  check('currency',        e.currency,         result.currency,       result.currency === e.currency);

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
    const actual  = result.approvalChainIds ?? [];
    const pass    = JSON.stringify(actual) === JSON.stringify(e.approval_chain_ids);
    check('chain', e.approval_chain_ids.join(','), actual.join(','), pass);
  } else {
    check('chain', null, undefined, true);
  }

  return checks;
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface EvalRow {
  id:            string;
  label:         EvalLabel;
  result:        ProcessResult;
  checks:        FieldCheck[];
  latencyMs:     number;
  error?:        string;
  falseApproval: boolean;
}

async function main() {
  const configPath = resolve(process.cwd(), 'config/toastwerk/config.json');
  const config     = loadConfig(configPath);
  const client     = new AnthropicClient();
  const db         = initDb(':memory:');

  // Load label files from eval/labels/*.json, sorted by name.
  const labelsDir  = resolve(process.cwd(), 'eval/labels');
  const labelFiles = readdirSync(labelsDir).filter(f => f.endsWith('.json')).sort();

  console.log(`\nEval harness — ${labelFiles.length} emails\n`);

  const rows: EvalRow[] = [];
  let totalCostChf = 0;

  for (const labelFile of labelFiles) {
    const id    = labelFile.replace('.json', '');
    const label = LabelSchema.parse(
      JSON.parse(readFileSync(join(labelsDir, labelFile), 'utf-8')),
    );
    const emailPath = resolve(process.cwd(), label.email_file);

    process.stdout.write(`  ${id}  ${label.description.slice(0, 50).padEnd(50)}  `);
    const t0 = Date.now();

    let result: ProcessResult;
    let error: string | undefined;

    try {
      result = await processEml(emailPath, { db, client, config });
    } catch (err) {
      result = { status: 'failed', emailPath, error: String(err) };
      error  = String(err);
    }

    const latencyMs = Date.now() - t0;
    const checks    = checkLabel(label, result);
    const allPass   = checks.filter(c => !c.skipped).every(c => c.pass);

    // False auto-approval: we submitted when we should not have.
    const falseApproval =
      result.status === 'submitted' && label.expected.status !== 'submitted';

    console.log(
      `${allPass ? '✓' : '✗'}  ${(latencyMs / 1000).toFixed(1)}s  ${result.status}`,
    );

    rows.push({ id, label, result, checks, latencyMs, error, falseApproval });
  }

  // ── Aggregate metrics ────────────────────────────────────────────────────────

  const n                = rows.length;
  const falseApprovals   = rows.filter(r => r.falseApproval).length;
  const statusMatches    = rows.filter(r => r.checks.find(c => c.field === 'status')?.pass).length;
  const reviewShare      = rows.filter(r =>
    r.result.status === 'needs_human_review' || r.result.status === 'needs_clarification' || r.result.status === 'security',
  ).length;
  const avgLatency       = rows.reduce((s, r) => s + r.latencyMs, 0) / n;
  const unverified       = rows.filter(r => r.label.verify_after_run);
  const failures         = rows.filter(r => r.checks.some(c => !c.skipped && !c.pass));

  // Collect field-level accuracy for non-skipped checks.
  const allChecks  = rows.flatMap(r => r.checks.filter(c => !c.skipped && c.field !== 'status'));
  const fieldPass  = allChecks.filter(c => c.pass).length;
  const fieldTotal = allChecks.length;

  // ── Write results to eval/results/last_run.json ───────────────────────────

  const resultsDir = resolve(process.cwd(), 'eval/results');
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    join(resultsDir, 'last_run.json'),
    JSON.stringify({ date: new Date().toISOString(), rows }, null, 2),
  );

  // ── Generate docs/eval.md ─────────────────────────────────────────────────

  const now     = new Date().toISOString().slice(0, 10);
  const model   = config.models.extraction;
  const fa      = falseApprovals === 0 ? `**0 / ${n}** ✓` : `**${falseApprovals} / ${n}** ✗ CRITICAL`;

  const summaryTable = [
    '| Metric | Value |',
    '|--------|-------|',
    `| Emails run | ${n} |`,
    `| Status accuracy | ${statusMatches} / ${n} (${pct(statusMatches, n)}%) |`,
    `| Field accuracy (non-status) | ${fieldPass} / ${fieldTotal} (${pct(fieldPass, fieldTotal)}%) |`,
    `| False auto-approvals | ${fa} |`,
    `| Review/security share | ${reviewShare} / ${n} (${pct(reviewShare, n)}%) |`,
    `| Avg latency per email | ${(avgLatency / 1000).toFixed(1)} s |`,
    `| Unverified (verify_after_run) | ${unverified.length} |`,
  ].join('\n');

  const perEmailRows = rows.map(r => {
    const statusCheck = r.checks.find(c => c.field === 'status')!;
    const otherFails  = r.checks.filter(c => !c.skipped && !c.pass && c.field !== 'status');
    const icon        = statusCheck.pass ? '✓' : '✗';
    const flagged     = r.label.verify_after_run ? ' ⚑' : '';
    return `| ${r.id} | ${r.label.description.slice(0, 45)} | ${r.label.expected.status} | ${r.result.status} | ${icon}${flagged} | ${otherFails.map(c => c.field).join(', ') || '—'} |`;
  });

  const perEmailTable = [
    '| ID | Description | Expected | Actual | Status | Field failures |',
    '|----|-------------|----------|--------|--------|----------------|',
    ...perEmailRows,
  ].join('\n');

  const failureSection = failures.length === 0
    ? 'No failures.'
    : failures.map(r => {
      const badChecks = r.checks.filter(c => !c.skipped && !c.pass);
      return [
        `### ${r.id} — ${r.label.description}`,
        '',
        badChecks.map(c =>
          `- **${c.field}**: expected \`${c.expected}\`, got \`${c.actual}\``,
        ).join('\n'),
        r.error ? `\n> Error: ${r.error}` : '',
      ].join('\n');
    }).join('\n\n');

  const unverifiedSection = unverified.length === 0
    ? 'None.'
    : unverified.map(r =>
      `- **${r.id}** — ${r.label.description} (${r.result.status})`,
    ).join('\n');

  const report = `# Eval report — ${now}

Generated by \`npm run eval\`. Model: ${model}.
Labels: \`eval/labels/\`. Raw results: \`eval/results/last_run.json\`.

## Summary

${summaryTable}

## Per-email results

⚑ = \`verify_after_run: true\` (expected value depends on LLM behaviour; update label after confirming)

${perEmailTable}

## Failures

${failureSection}

## Unverified labels

Labels marked \`verify_after_run: true\` — review after first run and update \`eval/labels/<ID>.json\` if needed.

${unverifiedSection}

## False auto-approvals

**${falseApprovals === 0 ? 'Zero — pipeline never submitted when it should not have.' : `${falseApprovals} CRITICAL — pipeline submitted when it should not have!`}**
`;

  writeFileSync(resolve(process.cwd(), 'docs/eval.md'), report, 'utf-8');

  // ── Console summary ──────────────────────────────────────────────────────

  console.log('\n─────────────────────────────────────────');
  console.log(`Status accuracy:  ${statusMatches}/${n}  (${pct(statusMatches, n)}%)`);
  console.log(`Field accuracy:   ${fieldPass}/${fieldTotal}  (${pct(fieldPass, fieldTotal)}%)`);
  console.log(`False approvals:  ${falseApprovals === 0 ? '0 ✓' : falseApprovals + ' ✗ CRITICAL'}`);
  console.log(`Avg latency:      ${(avgLatency / 1000).toFixed(1)} s`);
  console.log(`\nReport written to docs/eval.md`);

  if (falseApprovals > 0) {
    console.error('\n⛔  CRITICAL: false auto-approvals detected. See docs/eval.md for details.');
    process.exit(1);
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '0' : Math.round((n / d) * 100).toString();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
