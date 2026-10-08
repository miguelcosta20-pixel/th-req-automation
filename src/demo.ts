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
import { ingestEml } from './ingest/ingest.js';
import { resolveRequisition } from './resolution/resolve.js';
import { submitPO } from './output/submit.js';
import { insertPO } from './output/audit.js';

const PORT       = parseInt(process.env.DEMO_PORT ?? '3000', 10);
const ROOT       = process.cwd();
const htmlPath   = resolve(ROOT, 'demo/index.html');
const inboxDir   = resolve(ROOT, 'demo/inbox');
const configPath = resolve(ROOT, 'config/toastwerk/config.json');

const config = loadConfig(configPath);
const client = new AnthropicClient();
const db     = initDb(resolve(ROOT, config.dbPath));

// FX rates from master data — exposed to the frontend via /api/state so the
// demo UI can convert amounts when the clerk changes the PO currency.
const masterDataPath = resolve(ROOT, config.masterDataPath);
const masterData     = JSON.parse(readFileSync(masterDataPath, 'utf-8'));
const fxRates: Record<string, number> = masterData._meta?.fx_rates_to_chf ?? { CHF: 1.0 };

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
  sender_name: string | null; sender_email: string | null;
  received_at: string | null; created_at: string;
  extraction_json: string | null; resolution_json: string | null;
  draft_reply: string | null; email_path: string; message_id: string;
  po_number: string | null; approval_state_json: string | null;
}

function minConfidence(extraction: any): number | null {
  const fc = extraction?.field_confidence;
  if (!fc) return null;
  const scores = REQUIRED_CONFIDENCE_FIELDS.map(f => fc[f]).filter(v => typeof v === 'number');
  return scores.length ? Math.min(...scores) : null;
}

// Sum of line items in the email's own currency (the "stated" amount, before FX).
function statedTotal(extraction: any): number | null {
  const items = extraction?.line_items;
  if (!items || !items.length) return null;
  let any = false, sum = 0;
  for (const i of items) {
    if (i.quantity == null || i.unit_price == null) continue;
    any = true;
    sum += i.price_basis === 'per_100' ? (i.quantity * i.unit_price) / 100 : i.quantity * i.unit_price;
  }
  return any ? sum : null;
}

// Short, plain-language label for a review reason code.
const REASON_LABELS: Record<string, string> = {
  security_flag:         'security block',
  unknown_supplier:      'unknown supplier',
  blocked_supplier:      'supplier blocked',
  ambiguous_supplier:    'ambiguous supplier',
  missing_cost_centre:   'cost centre not identified',
  no_approval_chain:     'approval chain unresolved',
  no_line_items:         'no line items extracted',
  missing_delivery_date: 'missing delivery date',
  low_confidence:        'low extraction confidence',
  extraction_failed:     'extraction failed',
  processing_failed:     'processing failed',
  over_page_limit:       'attachment exceeds page limit',
};
const QUEUE_SEVERITY: Record<string, number> = { security: 0, human: 1, clarification: 2 };

// One short reason for a non-submitted row. Prefers the most severe review item,
// and uses the real approval-chain cause instead of a generic "chain failed".
function primaryReason(status: string, items: any[], chain: any): string | null {
  if (status === 'submitted') return null;
  if (status === 'duplicate') return 'duplicate — reused existing PO';
  if (status === 'failed' && items.length === 0) return 'processing failed';
  if (items.length === 0) return null;

  const sorted = [...items].sort((a, b) => (QUEUE_SEVERITY[a.queue] ?? 9) - (QUEUE_SEVERITY[b.queue] ?? 9));
  const top = sorted[0];

  let label: string;
  if (top.code === 'no_approval_chain' && chain && chain.ok === false && chain.reason) {
    label = chain.reason;                       // real cause (e.g. requester-is-approver)
  } else {
    label = REASON_LABELS[top.code] ?? top.code.replace(/_/g, ' ');
  }
  const extra = sorted.length - 1;
  return extra > 0 ? `${label} (+${extra} more)` : label;
}

function queueRows() {
  const rows = db.prepare(`
    SELECT r.id, r.status, r.subject, r.sender_name, r.sender_email,
           r.received_at, r.created_at, r.extraction_json, r.resolution_json,
           r.approval_state_json,
           (SELECT po_number FROM po WHERE po.requisition_id = r.id) AS po_number
    FROM requisition r
    ORDER BY r.id DESC
  `).all() as RequisitionRow[];

  // Fetch all review items once, grouped by requisition.
  const reviews = db.prepare(`SELECT requisition_id, code, queue, detail FROM review_item`).all() as any[];
  const byReq = new Map<number, any[]>();
  for (const rv of reviews) {
    if (!byReq.has(rv.requisition_id)) byReq.set(rv.requisition_id, []);
    byReq.get(rv.requisition_id)!.push(rv);
  }

  return rows.map(r => {
    const ext = safeParse<any>(r.extraction_json);
    const sol = safeParse<any>(r.resolution_json);
    const chainResult = sol?.chain ?? null;
    // Show the chain whether it passed or failed (the failed case now carries the
    // flagged steps, e.g. a requester-is-approver conflict).
    const steps = chainResult?.chain ?? null;

    // Compute how many approvers have approved, using the persisted approval state.
    const approvalState = safeParse<any>(r.approval_state_json);
    const savedStates   = approvalState?.states   ?? {};
    const savedAlts     = approvalState?.alternates ?? {};
    const chainLen = steps?.length ?? 0;
    const approvedCount = chainLen === 0 ? 0 : (steps as any[]).filter((s: any, i: number) => {
      if (s.requiresAlternate) return !!savedAlts[i] && savedStates[`alt-${i}`] === 'approved';
      return savedStates[i] === 'approved';
    }).length;

    return {
      id:              r.id,
      status:          r.status,
      subject:         r.subject,
      requester:       r.sender_name ?? r.sender_email ?? ext?.requester_name ?? '—',
      supplier:        sol?.supplier?.match?.name ?? ext?.supplier_name ?? null,
      totalChf:        typeof sol?.computedTotalChf === 'number' ? sol.computedTotalChf : null,
      statedTotal:     statedTotal(ext),
      currency:        sol?.currency ?? ext?.currency ?? null,
      chain: steps ? steps.map((s: any, i: number) => {
        const stepStatus = s.requiresAlternate
          ? (savedAlts[i] ? (savedStates[`alt-${i}`] ?? 'pending') : 'pending')
          : (savedStates[i] ?? 'pending');
        return { name: s.name, role: s.role, requiresAlternate: !!s.requiresAlternate, status: stepStatus };
      }) : null,
      chainOk:         chainResult?.ok ?? null,
      chainLength:     chainLen,
      approvedCount,
      minConfidence:   minConfidence(ext),
      reason:          primaryReason(r.status, byReq.get(r.id) ?? [], chainResult),
      extractionFailed: !ext,
      poNumber:        r.po_number,
      receivedAt:      r.received_at,
      createdAt:       r.created_at,
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
    reason: primaryReason(r.status, reviewItems, safeParse<any>(r.resolution_json)?.chain ?? null),
    email,
    extraction: safeParse(r.extraction_json),
    resolution: safeParse(r.resolution_json),
    draftReply: r.draft_reply,
    reviewItems,
    approvalState: safeParse(r.approval_state_json),
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
      sendJson(res, 200, { mockApi: await isMockApiUp(), dbPath: config.dbPath, customer: config.customer, fxRates });
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

    // Transitions a needs_human_review / needs_clarification requisition to
    // waiting_approval, persisting the status so navigation doesn't reset it.
    // Accepts optional clerk overrides (supplier_id, delivery_date, currency,
    // line_items, cost_centre_code) and re-resolves so the chain and delivery
    // date are always computed from the saved data, not from in-memory state.
    const waitingMatch = path.match(/^\/api\/requisition\/(\d+)\/waiting$/);
    if (method === 'POST' && waitingMatch) {
      const id  = parseInt(waitingMatch[1], 10);
      const row = db.prepare(`SELECT * FROM requisition WHERE id = ?`).get(id) as RequisitionRow | undefined;
      if (!row) { sendJson(res, 404, { error: 'not found' }); return; }

      const bodyText = (await readBody(req)).toString('utf-8').trim();
      const overrides = safeParse<any>(bodyText) ?? {};

      let ext = safeParse<any>(row.extraction_json) ?? {};

      // Apply clerk overrides to the extraction so re-resolution picks them up.
      if (overrides.delivery_date) {
        ext = { ...ext, delivery: { ...(ext.delivery ?? {}), kind: 'explicit', explicit_date: overrides.delivery_date, timeframe: overrides.delivery_date, evidence: 'clerk override', reasoning: 'Date entered by clerk' } };
      }
      if (overrides.supplier_id) {
        // Resolve the ID to a name so fuzzy matching in resolveRequisition works.
        const supplier = config.masterData.suppliers.find((s: any) => s.id === overrides.supplier_id);
        ext = { ...ext, supplier_name: supplier?.name ?? overrides.supplier_id };
      }
      if (overrides.cost_centre_code) {
        ext = { ...ext, cost_centre_hint: overrides.cost_centre_code };
      }
      if (overrides.currency) {
        ext = { ...ext, currency: overrides.currency };
      }
      if (Array.isArray(overrides.line_items) && overrides.line_items.length > 0) {
        ext = { ...ext, line_items: overrides.line_items };
      }

      // Re-resolve with the updated extraction — recomputes chain, total, delivery.
      const anchorDate = new Date(row.received_at ?? row.created_at);
      const sol = resolveRequisition(ext, config.masterData, anchorDate, config.thresholds.defaultDeliveryLeadDays);

      db.prepare(`
        UPDATE requisition
        SET status = 'waiting_approval', extraction_json = ?, resolution_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(ext), JSON.stringify(sol), id);

      sendJson(res, 200, { ok: true });
      return;
    }

    // Persists the in-progress approval state (which approvers have approved/rejected
    // and any alternate approver assignments) so it survives navigation and refresh.
    const approvalStateMatch = path.match(/^\/api\/requisition\/(\d+)\/approval-state$/);
    if (method === 'POST' && approvalStateMatch) {
      const id = parseInt(approvalStateMatch[1], 10);
      const row = db.prepare(`SELECT id FROM requisition WHERE id = ?`).get(id);
      if (!row) { sendJson(res, 404, { error: 'not found' }); return; }
      const bodyText = (await readBody(req)).toString('utf-8').trim();
      db.prepare(`UPDATE requisition SET approval_state_json = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(bodyText, id);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Marks a requisition as rejected when an approver declines it.
    const rejectMatch = path.match(/^\/api\/requisition\/(\d+)\/reject$/);
    if (method === 'POST' && rejectMatch) {
      const id = parseInt(rejectMatch[1], 10);
      const row = db.prepare(`SELECT id FROM requisition WHERE id = ?`).get(id);
      if (!row) { sendJson(res, 404, { error: 'not found' }); return; }
      db.prepare(`UPDATE requisition SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Reverts a waiting_approval requisition back to needs_human_review so the
    // clerk can edit the form and fix data errors caught at submission time.
    const reopenMatch = path.match(/^\/api\/requisition\/(\d+)\/reopen$/);
    if (method === 'POST' && reopenMatch) {
      const id = parseInt(reopenMatch[1], 10);
      const row = db.prepare(`SELECT id FROM requisition WHERE id = ?`).get(id);
      if (!row) { sendJson(res, 404, { error: 'not found' }); return; }
      db.prepare(`UPDATE requisition SET status = 'needs_human_review', updated_at = datetime('now') WHERE id = ?`).run(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Clerk-initiated PO submission after the mock approval cycle completes.
    // Idempotent: returns the existing PO number if the requisition was already submitted.
    const submitMatch = path.match(/^\/api\/requisition\/(\d+)\/submit$/);
    if (method === 'POST' && submitMatch) {
      const id  = parseInt(submitMatch[1], 10);
      const row = db.prepare(`SELECT * FROM requisition WHERE id = ?`).get(id) as RequisitionRow | undefined;
      if (!row) { sendJson(res, 404, { error: 'requisition not found' }); return; }

      const existing = db.prepare(`SELECT po_number FROM po WHERE requisition_id = ?`).get(id) as { po_number: string } | undefined;
      if (existing) { sendJson(res, 200, { poNumber: existing.po_number, alreadySubmitted: true }); return; }

      let ext = safeParse<any>(row.extraction_json);
      let sol = safeParse<any>(row.resolution_json);
      if (!ext || !sol) { sendJson(res, 400, { error: 'missing extraction or resolution data' }); return; }

      // The clerk may have filled in fields that were missing in the original extraction
      // (e.g. supplier or delivery date for needs_clarification requisitions). Accept
      // those overrides from the request body so the PO can be created with the correct data.
      const bodyText = (await readBody(req)).toString('utf-8').trim();
      const overrides = safeParse<any>(bodyText) ?? {};

      if (overrides.supplier_id && !sol.supplier?.match) {
        sol = { ...sol, supplier: { match: { id: overrides.supplier_id, name: overrides.supplier_id }, ambiguous: false } };
      }
      if (overrides.delivery_date && !sol.delivery?.date) {
        sol = { ...sol, delivery: { ...(sol.delivery ?? {}), date: overrides.delivery_date, kind: 'specific', basis: 'clerk override' } };
      }
      if (overrides.currency) {
        sol = { ...sol, currency: overrides.currency };
        ext = { ...ext, currency: overrides.currency };
      }
      if (Array.isArray(overrides.line_items) && overrides.line_items.length > 0) {
        ext = { ...ext, line_items: overrides.line_items };
      }

      if (!sol.supplier?.match) { sendJson(res, 422, { error: 'supplier not resolved — enter a supplier ID and retry' }); return; }
      if (!sol.delivery?.date)  { sendJson(res, 422, { error: 'delivery date not resolved — enter a delivery date and retry' }); return; }

      // Validate line items: every submitted item must have a positive quantity and
      // unit_price. Items extracted with null prices were silently dropped from the
      // clerk form — catch that here so we never hit the PO API with a bad payload.
      const items: any[] = ext.line_items ?? [];
      if (items.length === 0) {
        sendJson(res, 422, { error: 'No line items — go back and add at least one item with quantity and price.', fixable: true });
        return;
      }
      const badItems = items.filter((it: any) => !(it.quantity > 0) || !(it.unit_price > 0));
      if (badItems.length > 0) {
        const names = badItems.map((it: any) => it.description || 'unnamed item').join(', ');
        sendJson(res, 422, { error: `Line items missing quantity or price: ${names}. Go back and fill them in.`, fixable: true });
        return;
      }

      try {
        const idempotencyKey = row.message_id || `REQ-${id}`;
        const po = await submitPO(config.poApiUrl, sol as any, ext as any, idempotencyKey);
        insertPO(db, id, po, sol.supplier.match.id, sol.computedTotalChf ?? 0, sol.currency ?? ext.currency ?? 'CHF', idempotencyKey);
        db.prepare(`UPDATE requisition SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(id);
        sendJson(res, 200, { poNumber: po.poNumber, status: po.status, warnings: po.warnings ?? [] });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
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
