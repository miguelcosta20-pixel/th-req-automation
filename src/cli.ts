import 'dotenv/config';
import { readdirSync } from 'fs';
import { resolve, join, extname, basename } from 'path';
import { initDb } from './db';
import { loadConfig } from './config';
import { AnthropicClient } from './llm/anthropic';
import { processEml } from './pipeline';
import type { ProcessResult } from './types';

const DEFAULT_CONFIG = './config/toastwerk/config.json';

const [, , command, ...args] = process.argv;

async function main() {
  const configPath = resolve(process.cwd(), DEFAULT_CONFIG);
  const config     = loadConfig(configPath);
  const db         = initDb(resolve(process.cwd(), config.dbPath));
  const client     = new AnthropicClient();

  const deps = { db, client, config };

  switch (command) {
    case 'run': {
      const emailPath = args[0];
      if (!emailPath) {
        console.error('Usage: tsx src/cli.ts run <email.eml>');
        process.exit(1);
      }
      const result = await processEml(resolve(process.cwd(), emailPath), deps);
      printResult(result);
      break;
    }

    case 'run-all': {
      const dir = args[0] || './data/emails';
      const absDir = resolve(process.cwd(), dir);
      const files = readdirSync(absDir)
        .filter(f => extname(f).toLowerCase() === '.eml')
        .sort();

      if (files.length === 0) {
        console.log(`No .eml files found in ${absDir}`);
        break;
      }

      console.log(`Processing ${files.length} email(s) from ${dir}...\n`);

      const start   = Date.now();
      const results: ProcessResult[] = [];

      for (const file of files) {
        const result = await processEml(join(absDir, file), deps);
        results.push(result);
        const icon = statusIcon(result.status);
        console.log(`  ${icon} ${basename(result.emailPath)}`);
        if (result.error)   console.log(`     Error: ${result.error}`);
        if (result.poNumber) console.log(`     PO: ${result.poNumber}`);
        if (result.reasons?.length) {
          result.reasons.slice(0, 2).forEach(r => console.log(`     • ${r.code}: ${r.detail}`));
        }
      }

      printSummary(results, Date.now() - start);
      break;
    }

    case 'status': {
      const emailPath = args[0];
      if (!emailPath) {
        // Show recent requisitions
        const rows = db.prepare(`
          SELECT message_id, subject, status, created_at
          FROM requisition ORDER BY created_at DESC LIMIT 20
        `).all() as Array<{ message_id: string; subject: string; status: string; created_at: string }>;

        if (rows.length === 0) {
          console.log('No requisitions processed yet.');
        } else {
          console.log('Recent requisitions:\n');
          rows.forEach(r => {
            console.log(`  ${statusIcon(r.status)} ${r.status.padEnd(22)} ${r.subject ?? ''}`);
            console.log(`     ${r.message_id}`);
          });
        }
        break;
      }

      // Look up one specific email by its resolved path.
      const absPath = resolve(process.cwd(), emailPath);
      const row = db.prepare(`
        SELECT r.message_id, r.subject, r.status, r.created_at,
               p.po_number
        FROM requisition r
        LEFT JOIN po p ON p.requisition_id = r.id
        WHERE r.email_path = ?
        ORDER BY r.created_at DESC LIMIT 1
      `).get(absPath) as { message_id: string; subject: string; status: string; created_at: string; po_number: string | null } | undefined;

      if (!row) {
        console.log(`No record for ${emailPath} — process it first with: tsx src/cli.ts run ${emailPath}`);
      } else {
        console.log(`  ${statusIcon(row.status)} ${row.status.padEnd(22)} ${row.subject ?? ''}`);
        console.log(`     ${row.message_id}`);
        if (row.po_number) console.log(`     PO: ${row.po_number}`);
      }
      break;
    }

    default:
      console.error(
        'Usage:\n' +
        '  tsx src/cli.ts run <email.eml>\n' +
        '  tsx src/cli.ts run-all [data/emails]\n' +
        '  tsx src/cli.ts status\n',
      );
      process.exit(1);
  }

  db.close();
}

function printResult(r: ProcessResult) {
  const line = '─'.repeat(50);
  console.log(`\n${line}`);
  console.log(`  File:    ${basename(r.emailPath)}`);
  console.log(`  Status:  ${statusIcon(r.status)} ${r.status}`);
  if (r.poNumber)  console.log(`  PO:      ${r.poNumber}`);
  if (r.supplier)  console.log(`  Supplier:${r.supplier}`);
  if (r.totalChf != null) console.log(`  Total:   CHF ${r.totalChf.toFixed(2)}`);
  if (r.error)     console.log(`  Error:   ${r.error}`);
  if (r.reasons?.length) {
    console.log(`  Reasons:`);
    r.reasons.forEach(x => console.log(`    [${x.queue}] ${x.code}: ${x.detail}`));
  }
  if (r.draftReply) {
    console.log(`\n  Draft reply:\n`);
    r.draftReply.split('\n').forEach(l => console.log(`  ${l}`));
  }
  console.log(line);
}

function printSummary(results: ProcessResult[], elapsedMs: number) {
  const counts = new Map<string, number>();
  for (const r of results) {
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }

  const elapsed = elapsedMs < 60_000
    ? `${(elapsedMs / 1000).toFixed(1)}s`
    : `${Math.floor(elapsedMs / 60_000)}m ${((elapsedMs % 60_000) / 1000).toFixed(0)}s`;

  console.log('\n' + '─'.repeat(40));
  for (const [status, count] of [...counts.entries()].sort()) {
    console.log(`  ${statusIcon(status)} ${status.padEnd(24)} ${count}`);
  }
  console.log('─'.repeat(40));
  console.log(`  Total: ${results.length}  •  ${elapsed}`);
}

function statusIcon(status: string): string {
  switch (status) {
    case 'submitted':          return '✓';
    case 'duplicate':          return '-';
    case 'needs_clarification':return '?';
    case 'needs_human_review': return '⚠';
    case 'security':           return '✗';
    case 'failed':             return '✗';
    default:                   return ' ';
  }
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
