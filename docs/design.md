# Design: Requisition-to-PO Automation

Deterministic decisions, LLM-only extraction, config-driven per customer. TypeScript/Node per [CLAUDE.md](../CLAUDE.md). Pairs with [data-profile.md](data-profile.md).

---

## 1. Data model (SQLite, better-sqlite3)

One file DB, `data/state.db`, WAL mode. better-sqlite3 is synchronous — simple, fast, and more than enough for <500 writes/day. Tables:

- **requisition** — one row per `.eml`. `id`, `message_id` (RFC 822, unique), `source_path`, `received_at`, `raw_sha256`, `status` (`ingested|extracted|resolved|ready|needs_review|needs_clarification|submitted|failed`), `idempotency_key`, `created_at`.
- **attachment** — `id`, `requisition_id`, `filename`, `sha256`, `media_type`, `bytes` (or a path to them), `kind` (`pdf|other`). No extracted text column — the model reads the PDF (see §2).
- **extraction** — `id`, `requisition_id`, `prompt_version`, `model`, `schema_version`, `payload_json` (the Zod-validated output), `overall_confidence`, `created_at`. Append-only; every attempt is kept.
- **field_provenance** — `extraction_id`, `field_path`, `value`, `confidence`, `source` (`email_body|attachment|master_data|default`). Drives the review UI and the confidence gate.
- **resolution** — resolved `supplier_id`, `cost_centre`, `gl_account`, `employee_id`, each with a `score` and `match_method` (`exact|fuzzy|default`); `fx_rate`, `total_chf`, `approval_band`, `approval_chain_json`.
- **po** — `requisition_id` (unique), `po_number`, `response_json`, `submitted_at`. DB-level uniqueness is the last guard against a duplicate PO.
- **llm_call** — `requisition_id`, `prompt_version`, `model`, `input_sha256`, `output_json`, `latency_ms`, `tokens_in/out`, `cost_chf`, `created_at`.
- **review_item** — `requisition_id`, `reason_code`, `detail`, `queue` (`clarification|human|security`), `resolved_by`, `resolved_at`.

Append-only extraction/llm_call rows mean a reprocess never destroys history; `po` uniqueness stops double-booking even if upstream logic slips.

## 2. Module layout

```
src/
  llm/
    client.ts       # LlmClient interface — ONLY file that imports the SDK
    anthropic.ts    # concrete impl; model/provider chosen from config
    pricing.ts      # tokens → cost_chf
  ingest.ts         # mailparser: headers, body, thread flattening, attachments
  attachments.ts    # select PDFs, cap pages, build Anthropic document blocks
  extract.ts        # render prompt + call LlmClient + Zod-validate + retry-once
  resolve.ts        # fuse.js match to master data; FX; total_chf
  approvals.ts      # band lookup, chain build, self-approval/collapse rules
  decide.ts         # status machine: ready | clarification | review | security
  submit.ts         # idempotent POST to the Python mock API over HTTP
  audit.ts          # llm_call + status transitions
  config.ts         # load + Zod-validate a per-customer config bundle
  schema.ts         # Zod schemas: extraction, master data, PO request
  cli.ts            # one command (tsx): process a folder of .eml
prompts/            # versioned, provider-neutral (extract.v1.md …)
config/<customer>/  # master_data.json, thresholds, matching, queues, model map
tests/              # approvals, FX, resolution first (Vitest, deterministic)
```

The SDK is quarantined in `src/llm/`; nothing else may import it (CLAUDE.md). Deterministic modules (`resolve`, `approvals`, `decide`) are pure functions over plain objects — Vitest covers them with no I/O. `mock_po_api.py` is never imported; `submit.ts` only speaks HTTP to it.

## 3. Schemas (Zod at every boundary)

Three Zod schemas guard the three external surfaces CLAUDE.md names — **LLM output**, **PO API request**, **master data on load**. Parsing failure is a typed error, never a thrown surprise. The internal canonical requisition carries, per field, a `{value, confidence, source}` triple so provenance travels with the data.

**Exact LLM extraction schema** (`schema.ts`, `schema_version` pinned; the model returns *only* this — no totals, no routing it computed itself):

| Field | Zod type | Required | Notes |
|---|---|---|---|
| `requester_name` | `string.nullable()` | yes | as written |
| `requester_email` | `string.email().nullable()` | yes | from headers if body silent |
| `supplier_name` | `string.nullable()` | yes | verbatim text, **not** an ID |
| `currency` | `enum(CHF,EUR,USD,GBP).nullable()` | yes | |
| `cost_centre_hint` | `string.nullable()` | no | free text, e.g. "Linie A" |
| `delivery_date` | `string.nullable()` | no | ISO if parseable |
| `line_items` | `array(LineItem)` | yes | may be empty ⇒ review |
| `LineItem.description` | `string` | yes | |
| `LineItem.quantity` | `number.nullable()` | yes | |
| `LineItem.unit` | `string.nullable()` | yes | |
| `LineItem.unit_price` | `number.nullable()` | yes | |
| `LineItem.price_basis` | `enum(per_unit,per_100).nullable()` | no | captures the per-100 trap (email_25) |
| `LineItem.currency` | `enum(...).nullable()` | no | per-line override |
| `notes` | `string.nullable()` | no | |
| `instructions_to_reader` | `string.nullable()` | no | **quarantine field**: any imperative aimed at the processor ("don't ask the CFO") goes here, never acted on |
| `field_confidence` | `record(string, number.min(0).max(1))` | yes | path→self-estimate |

`instructions_to_reader` is the injection sink: giving the model a place to *put* commands stops it obeying them and hands `decide.ts` a signal (email_50).

## 4. Confidence (computed in code, not trusted from the model)

Per field: `conf = f(model_self_estimate, source_weight, agreement, resolution_strength)`

- **source_weight**: attachment/quote > email body > header-inferred > default.
- **agreement**: value in both body and PDF and matching → boost; conflict → floor 0.3 + a `conflict` reason.
- **resolution_strength**: exact master hit = 1.0; fuse.js score ≥ cutoff = score; below/ambiguous = low.
- **arithmetic**: Σ(qty×price, normalised for `price_basis`) ≠ quote total beyond ±0.01 → total floored (email_24).

Overall = **min** of required-field confidences (weakest-link: a PO is only as trustworthy as its worst load-bearing field). Config thresholds: `auto` (≥0.80) and `clarify_floor` (<0.50). Between → human review; below → clarification.

## 5. Review & clarification flows

`decide.ts` is a pure function (requisition + resolution + config) → status + reason codes:

- **ready** — required fields ≥ `auto`, supplier active, arithmetic clean, chain resolvable → `submit`.
- **needs_clarification** — a gap the *requester* can fill (no CC, approximate qty, missing quote). Produces a **draft reply** (templated, not auto-sent) naming exactly what's missing. Covers email_02, 04, 28, 30, 39, 44.
- **needs_human_review** — resolvable only by the clerk: fuzzy supplier ambiguity (SUP-001 vs 006), wrong total (email_24), blocked supplier (email_09), unknown CC-9100 (email_40), blanket order (email_37), framework contract (email_42), expired quote (email_31).
- **security** — a populated `instructions_to_reader` telling the processor to skip controls or not verify, **or** an approval asserted in-band (email_50). Separate queue, alerts, never auto-progresses.

Reason codes and their queue mapping live in config, so a new customer re-routes without code.

## 6. Error handling

- **LLM**: Zod-parse every response; on failure retry **once** with the validation error appended to the prompt; second failure → `needs_human_review`, never crash. Timeouts/5xx → bounded backoff in `LlmClient`, then review.
- **PDF**: sent as a document block, so the model does the reading — no local parse to fail. Guard tokens with a page cap (config, e.g. 15); over cap → review rather than a silent truncation (email_37's 24-line quote). A non-PDF or corrupt attachment → email-body-only extraction at lowered confidence.
- **API**: 422 → map `problems[]` to review reasons (don't blind-retry). 5xx/network → retry with the **same idempotency key**, `sha256(message_id + supplier_id + total_chf)`, so a retry can never double-book.
- **Isolation**: each `.eml` runs in its own try/catch; one failure sets that row to `failed` + audit, never breaking the batch.

## 7. Second customer

No code change. A customer is a `config/<name>/` bundle, each file Zod-validated on load: `master_data.json`; `thresholds.json` (approval bands, confidence cutoffs); `matching.json` (fuse.js cutoffs, alias overrides); `queues.json` (reason→queue); `models.json` (provider + model per task — extraction vs. any future classify step). `tsx src/cli.ts --customer <name>` selects the bundle. Approval limits, currencies, routing and model choice are all data. The one thing that could need code is a differently-shaped ERP endpoint — isolated behind `submit.ts`'s single adapter.

## 8. Scaling to 500 req/day

500/day ≈ one per ~3 min, peaks ~20–30/hr — small. better-sqlite3 is synchronous and in-process, which is fine here; the real bottleneck is LLM latency, which is network-bound and async.

- **Queue**: replace the folder scan with a durable queue (SQS/Redis); one `.eml` = one message, deduped on `message_id` at enqueue.
- **Workers**: `resolve/approvals/decide` are pure and parallel-safe. Run a pool of Node workers for the async LLM calls. Because better-sqlite3 is single-process-synchronous, at this scale keep **one writer process** (workers hand results to it) or move to Postgres — the schema is portable and only `config.ts`'s connection changes.
- **Rate limits**: concurrency cap + token bucket inside `LlmClient`; cache by `attachment.sha256` so a resent quote isn't re-sent to the model — the biggest single cost lever, since PDFs dominate tokens.
- **Cost**: ~1 extraction call/email. A quote sent as a document block is the token driver — a 2-page PDF plus prompt is roughly 3–10k input tokens. 500/day ≈ low single-digit M tokens/day → low tens of CHF/day on a mid-tier model; `llm_call.cost_chf` tracks it live. The page cap and the sha256 cache are the two guards.

Backpressure: if review outpaces the clerks, slow ingestion, never auto-submit to catch up.

---

## 9. Assumptions

1. One sender = one requester; the `From` header is authoritative for identity, never a body claim. Authority is checked in deterministic code, never taken from email text.
2. `.eml` is well-formed RFC 822; mailparser flattens thread/forward history reliably (email_45's 3-level chain).
3. PDFs are the price source of truth; email-body prices are hints unless no quote exists.
4. Attachments arrive inline/base64 in the `.eml` and are small enough to send whole as document blocks; the page cap handles the outlier (email_37).
5. Expired quotes → review, not auto-reject (dataset is dated May 2026; OQ-6). Configurable.
6. Approval band boundary: `total_chf > band.to` moves up; exactly 1000.00 stays band 1 (OQ-1). Top band `to: null` handled explicitly.
7. VAT: API `total` is gross, `tax_amount` is the VAT component when the quote shows one; a missing MwSt on a Swiss quote → review, never assume zero-rate (OQ-10/11/20).
8. FX from master data only; no live rates. Drafted clarification replies are never auto-sent in v1.

## 10. Trade-offs & rejected alternatives

- **PDF as document block vs. local parse**: follows CLAUDE.md — fewer deps, handles scans natively, no OCR stack to maintain. Rejected local text extraction (pdf-parse) as more code and worse on scans; the cost is higher token spend, bounded by the page cap + sha256 cache.
- **better-sqlite3 (synchronous) over an async driver**: simpler, faster for this volume, easy to reason about line-by-line (CLAUDE.md's "boring code"). Rejected async SQLite as needless ceremony; §8 shows the Postgres path is a connection swap.
- **LLM extracts, code decides**: rejected letting the model compute totals/routing/approvals — non-deterministic, untestable, and it would make the injection surface the decision surface (email_50). The `instructions_to_reader` quarantine is cheaper than a classifier.
- **Weakest-link confidence**: rejected averaging — a 0.95 mean can hide one 0.2 field that voids the PO.
- **Zod at boundaries only**: rejected validating internal hand-offs too — the types already hold once parsed; redundant checks add noise.
- **`LlmClient` seam**: rejected calling the SDK inline — it would scatter vendor lock-in and make swapping model/provider-per-task (config) impossible, and defeats provider-neutral prompts.
- **Retry-once then review**: rejected unbounded retries (cost/latency) and zero-retry (wastes recoverable Zod slips).
- **Config bundle per customer**: rejected a plugin/strategy-class system as over-engineered for "second customer = new config"; inspectable data files need no deploy.
- **Idempotency key from content hash**: rejected a per-attempt UUID (a retry would double-book) and `message_id` alone (a corrected resend, email_30, legitimately differs).
- **Folder scan in v1**: rejected standing up a queue now — unjustified ops cost at 500/day; the seam is defined so it's a swap, not a redesign.
