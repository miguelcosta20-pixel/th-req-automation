# Decisions and assumptions log

Running log for the Toastwerk requisition-to-PO take-home. Each entry: what, why, alternatives. Keep entries short, write them when the decision is made, and update the status as things change.

Status key: **Decided** (my call, final unless something changes) · **Proposed** (suggested, confirm after reading the data or design) · **Open** (needs an answer or more information)

Last updated: 2026-10-07

## Decisions

| # | Decision | Status | Why | Alternatives considered |
|---|---|---|---|---|
| D1 | Language: TypeScript (strict), Node 22 | Decided | I can explain it fluently line by line; it matches the backend stack the role calls for | Python (richer email/PDF libraries, matches the mock API) |
| D2 | Build with Claude Code; I review and must understand every part | Decided | Encouraged by the brief; faster delivery; the review protects against code I can't defend | Hand-writing everything (too slow for ~4h) |
| D3 | Repo layout: `data/` is their input, read-only; my work (src, tests, eval, docs, samples) sits at the repo root | Decided | Clear boundary between given input and my work; makes the walkthrough easier | Mixing eval files into `data/` |
| D4 | Small, frequent commits with meaningful messages; tag the demo build `v1-submission` | Decided | Reviewable history; easy rollback when generated code goes wrong | One large final commit |
| D5 | `mock_po_api.py` stays a separate Python process, called over HTTP | Decided | It's provided as a stand-in for the ERP; porting adds no value | Reimplementing it in TypeScript |
| D6 | Document as I go: this file, README "Assumptions" section (numbered A1, A2...), `docs/eval.md` | Decided | The brief asks for assumptions; it doubles as my cheat sheet for the live session | Writing docs at the end |
| D7 | The LLM only extracts structured fields; approval routing, FX conversion, thresholds and master-data resolution are deterministic, tested code | Decided | Predictable, testable, auditable; a wrong approval chain is the worst failure | Letting the LLM decide approvals end to end |
| D8 | All model calls go through one `LlmClient` interface; provider and model per task set in config | Decided | Swapping models is a config change, swapping providers one adapter; logs cost and latency per call | Direct SDK calls throughout the code |
| D9 | Send PDFs directly to the model as documents (page-count heuristic, 15-page limit, review if over) | Decided | No local PDF parser to maintain or explain; Claude handles layouts and scans natively | Local text extraction plus a vision fallback |
| D10 | Validate every LLM output with Zod; on failure retry once appending the error, then human review queue | Decided | The system never crashes on bad output and never guesses | Trusting the model output |
| D11 | Low confidence, missing required data or ambiguous matches go to review or a drafted clarification reply, never auto-approved | Decided | Zero wrong auto-approvals is the key quality metric | Best-guess filling |
| D12 | SQLite (better-sqlite3, WAL mode) for state and the audit log | Decided | Simple and auditable at this scale; Postgres plus a queue at 500+/day | Files only; Postgres from the start |
| D13 | Treat email and attachment content as untrusted data; LLM instructed to quarantine directives into `instructions_to_reader`; decide() routes non-empty field to security queue | Decided | Emails come from outside the pipeline; tested by injection.test.ts (T67–T74) | None |
| D14 | Own eval set of about 15 hand-labeled emails: field accuracy, approval-chain correctness, review share, cost and latency | Proposed | Gives numbers for the walkthrough and a safe way to compare models | Judging by eye |
| D15 | LLM provider: Anthropic; model per task in `config/toastwerk/config.json`; key in `.env` (see `.env.example`) | Decided | Anthropic SDK supports native PDF document blocks; no local PDF parsing needed | Another provider behind the same interface |
| D21 | Page-count heuristic: count `/Type /Page` (not `/Pages`) in raw PDF bytes; fall back to 1 on error | Decided | Avoids a PDF library; accurate for well-formed PDFs; safe default keeps single-page scans in scope | Full PDF parser (adds a dependency with its own CVEs) |
| D16 | Overall confidence is the lowest of the required fields, not an average | Proposed | A PO is only as good as its weakest field; a 0.9 average can hide one 0.2 that voids it | Averaging across fields |
| D17 | Idempotency key = hash of message-id + supplier + CHF total | Proposed | Survives an API retry without a second PO, but a genuine corrected resend still gets through | Random key per attempt; message-id alone |
| D18 | Approval band lookup ignores `from`; uses first band where `total ≤ band.to` (null = ∞) | Decided | Clean, no gap-handling code — 1000.50 naturally falls into band 2; resolves A1 | Checking `from` explicitly (requires gap-handling branch); rounding up to nearest integer |
| D19 | FX: apply rate to the full total once, round to 2 dp with `Math.round(total × 100) / 100` | Decided | Per-line rounding accumulates drift; one round at the end is predictable | Per-line rounding; Decimal.js (overkill for 2 dp) |
| D20 | Self-approval: remove requester from chain; valid iff remaining max role level ≥ band max | Decided | A higher role implicitly covers lower levels; if nobody above remains → human review | Reject the whole PO; escalate to next band |
| D22 | Demo UI is a two-screen SPA — a Queue of processed requisitions and a Detail view — with new emails added through a dialog (drop/paste + live progress). Small Node `http` server (`src/demo.ts`), plain HTML/JS (`demo/index.html`), no framework, no auth; `npm run demo` also spawns `mock_po_api.py` | Decided | This is the clerk's operational tool: a worklist you drill into, plus a way to add work. "Try/Quality/Rules" as peer tabs were demo scaffolding; adding an email is an action on the Queue, not a destination, so it became a dialog | A 5-tab SPA (Queue, Detail, Try, Quality, Rules — too much for an operational tool); a React/Vite build |
| D23 | Queue and Detail read from the operational SQLite DB (shared with the CLI) | Decided | The Queue reflects real processed requisitions and survives restarts | A separate demo DB |
| D24 | Live progress in the add dialog uses an optional `onStage` instrumentation hook on `processEml`, streamed to the browser as NDJSON | Decided | Honest, real stage events with a single source of truth; the hook defaults to no-op and never affects routing or output | Client-side faked progress; duplicating the pipeline steps in the server |
| D25 | Approval boundary cases live in `tests/fixtures/approval-cases.json`, the single source Vitest (`approvals.band.test.ts`) asserts against | Decided | One documented set of boundaries, exercised by the test suite. (Originally also surfaced in a Rules UI screen, dropped with D22 — the fixture + test remain the evidence) | Hard-coded cases inline in the test |
| D26 | Eval scoring (label schema, per-field checks, run, aggregate) lives in `src/eval-core.ts`, imported by the CLI (`src/eval.ts`) | Decided | Keeps `src/eval.ts` small and the checks testable in isolation. (Originally shared with a Quality UI screen, dropped with D22 — the CLI → `docs/eval.md` is the evaluation story) | Inlining all of it in `src/eval.ts` |

## Assumptions about the spec

Fill these in as they are resolved. Reference the number in code comments and commit messages.

| # | Question | Current default | Status |
|---|---|---|---|
| A1 | The approval table has gaps between ranges (e.g. 1,000.50 is neither ≤1,000 nor ≥1,001). Which band applies? | Anything above a band's upper limit moves to the next band (so 1,000.01 requires the second band) | Decided (D18) |
| A2 | Does the CHF total include VAT, shipping and discounts? | To decide after reading the quotes | Open |
| A3 | Which FX rate and rounding rule apply? | Rate from `master_data.json`, rounded at the total | Open |
| A4 | When information is missing, should the system draft a reply to the requester or only flag it? | Draft a reply and flag for the clerk | Open |
| A5 | Is the PO created before or after approvals are collected? | To decide after reading the mock API | Open |
| A6 | Requester equals approver, or one person holds two approval roles | To decide after reading master data | Open |
| A7 | What happens with duplicate requisitions (same email, forwarded twice)? | Idempotent: the same email never creates two POs | Proposed |

## Questions sent to the interviewers

Fill in dates and answers here.

- Threshold gaps (A1):
- VAT, shipping, discounts (A2):
- Draft replies vs. flagging only (A4):
- PO timing relative to approvals (A5):
- Expected output format, hidden test set:

## Log of changes

- 2026-10-07: initial decisions (D1 to D6 decided; D7 to D14 proposed; D15 open).
- 2026-10-07: implemented full pipeline; D7–D13, D15 → Decided; added D21 (PDF page heuristic); 79 tests passing (20 new for status machine and injection defence).
- 2026-10-07: added eval harness (15 labeled emails in eval/labels/, 3 edge-case .eml files) and demo mode (src/demo.ts + demo/index.html); `npm run eval` and `npm run demo` now work; 79 tests still passing.
- 2026-10-07: expanded the demo into a 5-screen web UI (Queue, Detail, Try, Quality, Rules) over the unchanged pipeline (D22–D26). Added `tests/fixtures/approval-cases.json` (shared by the band test and the Rules screen), extracted `src/eval-core.ts`, added an optional `onStage` progress hook to `processEml` (instrumentation only), and made `npm run demo` spawn the mock PO API. Note: labels live in `eval/labels/*.json` (a directory), not a single `labels.json`. 79 tests still passing; tsc clean.
- 2026-10-07: narrowed the UI to the operational core — Queue + Detail, with "add email" as a dialog instead of a tab (D22 revised). Dropped the Quality and Rules screens from the UI; they stay as `npm run eval` → `docs/eval.md` and the Vitest fixture. Removed the `/api/quality/*` and `/api/rules` endpoints; `src/eval-core.ts` and the fixture are now CLI/test-only. 79 tests still passing; tsc clean.
