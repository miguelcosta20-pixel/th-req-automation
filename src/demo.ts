// Demo web server for the requisition-to-PO pipeline.
//
//   npm run demo   →   http://localhost:3000   (+ starts the mock PO API)
//
// It serves a single-page app (demo/index.html) and a small JSON/NDJSON API.
// The server never re-implements pipeline logic: it calls the same processEml()
// the CLI uses and reads results from the same SQLite database.
//
// Two screens: a Queue of processed requisitions and a Detail view. New emails
// are added through a dialog that streams live progress while processEml() runs.
// (The evaluation and approval-rules views live in the CLI: `npm run eval` →
// docs/eval.md, and the Vitest fixture tests/fixtures/approval-cases.json.)
//
// Design notes:
//   - Operational store is the configured SQLite db (shared with the CLI), so
//     the Queue shows real processed requisitions and survives restarts.
//   - Live progress uses NDJSON (one JSON object per line) over a normal POST
//     response, read as a stream on the client. No SSE framing, no new deps.

import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { loadConfig } from './config.js';
import { initDb } from './db.js';
import { AnthropicClient } from './llm/anthropic.js';
import { processEml } from './pipeline.js';
import { ingestEml } from './ingest.js';

const PORT       = parseInt(process.env.DEMO_PORT ?? '3000', 10);
const ROOT       = process.cwd();
const htmlPath   = resolve(ROOT, 'demo/index.html');
const inboxDir   = resolve(ROOT, 'demo/inbox');
const configPath = resolve(ROOT, 'config/toastwerk/config.json');

const config = loadConfig(configPath);
const client = new AnthropicClient();
const db     = initDb(resolve(ROOT, config.dbPath));

mkdirSync(inboxDir, { recursive: true });

// Required-confidence fields (mirror of decide.ts D16): the Queue's "min
// confidence" column is the weakest of these, matching how the pipeline scores.
const REQUIRED_CONFIDENCE_FIELDS = ['requester_name', 'requester_email', 'supplier_name', 'currency', 'line_items'];

// ── Mock PO API lifecycle ──────────────────────────────────────────────────────

let mockApi: ChildProcess | null = null;

function mockApiPort(): number {
  const m = config.poApiUrl.match(/:(\d+)/);
  return m ? parseInt(m[1], 10) : 8080;
}

async function isMockApiUp(): Promise<boolean> {
  try {
    const res = await fetch(`${config.poApiUrl}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

// Starts tools/mock_po_api.py unless something already answers on its port.
// Failure is non-fatal: the rest of the UI works, only PO submission would fail.
async function startMockApi(): Promise<void> {
  if (await isMockApiUp()) {
    console.log(`Mock PO API already running on ${config.poApiUrl}`);
    return;
  }
  const script = resolve(ROOT, 'tools/mock_po_api.py');
  if (!existsSync(script)) {
    console.warn(`⚠ ${script} not found — PO submission will fail.`);
    return;
  }
  mockApi = spawn('python3', [script, String(mockApiPort())], { stdio: 'ignore' });
  mockApi.on('error', err => console.warn(`⚠ could not start mock PO API: ${err.message}`));

  for (let i = 0; i < 20; i++) {
    if (await isMockApiUp()) {
      console.log(`Mock PO API started on ${config.poApiUrl}`);
      return;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.warn('⚠ mock PO API did not come up within 5s — PO submission may fail.');
}

function stopMockApi(): void {
  if (mockApi && !mockApi.killed) mockApi.kill('SIGTERM');
}
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
  process.on(sig, () => { stopMockApi(); if (sig !== 'exit') process.exit(0); });
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end',  () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Opens an NDJSON stream and returns a writer that flushes one object per line.
function openStream(res: ServerResponse): (obj: unknown) => void {
  res.writeHead(200, {
    'Content-Type':  'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  return (obj: unknown) => res.write(JSON.stringify(obj) + '\n');
}

function safeParse<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try { return JSON.parse(json) as T; } catch { return null; }
}

// ── Queue ──────────────────────────────────────────────────────────────────────

interface RequisitionRow {
  id: number; status: string; subject: string | null;
  sender_name: string | null; sender_email: string | null; created_at: string;
  extraction_json: string | null; resolution_json: string | null;
  draft_reply: string | null; email_path: string; message_id: string;
  po_number: string | null;
}

function minConfidence(extraction: any): number | null {
  const fc = extraction?.field_confidence;
  if (!fc) return null;
  const scores = REQUIRED_CONFIDENCE_FIELDS.map(f => fc[f]).filter(v => typeof v === 'number');
  return scores.length ? Math.min(...scores) : null;
}

function queueRows() {
  const rows = db.prepare(`
    SELECT r.id, r.status, r.subject, r.sender_name, r.sender_email, r.created_at,
           r.extraction_json, r.resolution_json,
           (SELECT po_number FROM po WHERE po.requisition_id = r.id) AS po_number
    FROM requisition r
    ORDER BY r.id DESC
  `).all() as RequisitionRow[];

  return rows.map(r => {
    const ext = safeParse<any>(r.extraction_json);
    const sol = safeParse<any>(r.resolution_json);
    const chain = sol?.chain?.ok ? sol.chain.chain : null;
    return {
      id:            r.id,
      status:        r.status,
      subject:       r.subject,
      requester:     r.sender_name ?? r.sender_email ?? ext?.requester_name ?? '—',
      supplier:      sol?.supplier?.match?.name ?? ext?.supplier_name ?? null,
      totalChf:      typeof sol?.computedTotalChf === 'number' ? sol.computedTotalChf : null,
      currency:      sol?.currency ?? ext?.currency ?? null,
      chain:         chain ? chain.map((s: any) => ({ name: s.name, role: s.role })) : null,
      chainOk:       sol?.chain?.ok ?? null,
      minConfidence: minConfidence(ext),
      poNumber:      r.po_number,
      createdAt:     r.created_at,
    };
  });
}

// ── Detail ───────────────────────────────────────────────────────────────────

async function requisitionDetail(id: number) {
  const r = db.prepare(`SELECT * FROM requisition WHERE id = ?`).get(id) as RequisitionRow | undefined;
  if (!r) return null;

  const reviewItems = db.prepare(`SELECT code, queue, detail FROM review_item WHERE requisition_id = ?`).all(id);
  const po          = db.prepare(`SELECT po_number, supplier_id, currency, total_chf, api_response_json FROM po WHERE requisition_id = ?`).get(id) as any;
  const llmCalls    = db.prepare(`
    SELECT prompt_version, model, latency_ms, tokens_in, tokens_out, cost_chf, attempt, success
    FROM llm_call WHERE requisition_id = ? ORDER BY id
  `).all(id) as any[];

  // Re-parse the original .eml for the email panel. Cheap and deterministic — no
  // LLM involved. Missing file (e.g. deleted inbox) degrades to headers only.
  let email: any = {
    from: [r.sender_name, r.sender_email].filter(Boolean).join(' '),
    subject: r.subject, date: r.created_at, textBody: '(original email file unavailable)', attachments: [],
  };
  if (existsSync(r.email_path)) {
    const parsed = await ingestEml(readFileSync(r.email_path));
    email = {
      from:    [parsed.from.name, parsed.from.address].filter(Boolean).join(' '),
      subject: parsed.subject,
      date:    parsed.receivedAt.toISOString(),
      textBody: parsed.textBody,
      attachments: parsed.attachments.map((a, i) => ({
        idx: i, filename: a.filename, contentType: a.contentType,
        size: a.content.length, isPdf: a.contentType.includes('pdf'),
      })),
    };
  }

  return {
    id: r.id,
    status: r.status,
    email,
    extraction: safeParse(r.extraction_json),
    resolution: safeParse(r.resolution_json),
    draftReply: r.draft_reply,
    reviewItems,
    po: po ? { ...po, api_response: safeParse(po.api_response_json) } : null,
    llmCalls,
  };
}

async function attachmentBytes(id: number, idx: number) {
  const r = db.prepare(`SELECT email_path FROM requisition WHERE id = ?`).get(id) as { email_path: string } | undefined;
  if (!r || !existsSync(r.email_path)) return null;
  const parsed = await ingestEml(readFileSync(r.email_path));
  return parsed.attachments[idx] ?? null;
}

// ── Live single-email processing (NDJSON) ──────────────────────────────────────

async function streamProcess(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = (await readBody(req)).toString('utf-8').trim();
  const emit = openStream(res);

  if (!raw) { emit({ type: 'error', error: 'Empty email body.' }); res.end(); return; }

  // Persist the raw .eml so processEml has a path and the Detail view can re-read it.
  const emlPath = join(inboxDir, `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.eml`);
  writeFileSync(emlPath, raw, 'utf-8');

  emit({ type: 'stage', stage: 'received' });
  try {
    const result = await processEml(emlPath, {
      db, client, config,
      onStage: stage => emit({ type: 'stage', stage }),
    });

    // Map the message id back to the DB row so the client can open Detail.
    const row = result.messageId
      ? db.prepare(`SELECT id FROM requisition WHERE message_id = ?`).get(result.messageId) as { id: number } | undefined
      : undefined;

    emit({ type: 'done', status: result.status, id: row?.id ?? null, result });
  } catch (err) {
    emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  res.end();
}

// ── Router ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url    = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(htmlPath));
      return;
    }

    if (method === 'GET' && path === '/api/state') {
      sendJson(res, 200, { mockApi: await isMockApiUp(), dbPath: config.dbPath, customer: config.customer });
      return;
    }

    if (method === 'GET' && path === '/api/queue') {
      sendJson(res, 200, queueRows());
      return;
    }

    const detailMatch = path.match(/^\/api\/requisition\/(\d+)$/);
    if (method === 'GET' && detailMatch) {
      const detail = await requisitionDetail(parseInt(detailMatch[1], 10));
      if (!detail) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, detail);
      return;
    }

    const attMatch = path.match(/^\/api\/requisition\/(\d+)\/attachment\/(\d+)$/);
    if (method === 'GET' && attMatch) {
      const att = await attachmentBytes(parseInt(attMatch[1], 10), parseInt(attMatch[2], 10));
      if (!att) { sendJson(res, 404, { error: 'no such attachment' }); return; }
      res.writeHead(200, {
        'Content-Type': att.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${att.filename}"`,
      });
      res.end(att.content);
      return;
    }

    if (method === 'POST' && path === '/api/process') {
      await streamProcess(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found', path });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  }
});

async function main() {
  await startMockApi();
  server.listen(PORT, () => {
    console.log(`\n  PO Automation Demo  →  http://localhost:${PORT}`);
    console.log(`  Database: ${config.dbPath}   Mock API: ${config.poApiUrl}\n`);
  });
}

main().catch(err => { console.error(err); stopMockApi(); process.exit(1); });
