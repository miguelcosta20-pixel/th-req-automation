# th-req-automation

Turns purchase requisition emails (`.eml`, with optional PDF attachments) into purchase orders via a mock PO API, with the correct approval chain. Anything uncertain is flagged for the purchasing clerk.

## Prerequisites

- Node 22
- Python 3 (for the mock PO API)
- An Anthropic API key

## Setup

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
```

`.env` must contain:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Running the mock PO API

The mock API is a separate Python process. Start it before running the pipeline:

```bash
python mock_po_api.py
# listens on http://127.0.0.1:8080
```

## CLI usage

Process a single email:

```bash
tsx src/cli.ts run data/emails/sample.eml
```

Process all emails in a directory:

```bash
tsx src/cli.ts run-all data/emails
```

Check the status of a processed email:

```bash
tsx src/cli.ts status                        # last 20 requisitions
tsx src/cli.ts status data/emails/sample.eml # one specific email
```

## Demo UI

Starts a browser-based clerk workbench and spawns the mock PO API automatically:

```bash
npm run demo
# open http://localhost:3000
```

## Evaluation harness

Runs the pipeline over the labeled eval set in `eval/labels/` and prints a per-field accuracy report:

```bash
npm run eval
```

## Tests

```bash
npm test
```

## Configuration

Customer config lives in `config/toastwerk/config.json`. A second customer is a new config directory, not a code change. Key fields:

| Field | Purpose |
|---|---|
| `masterDataPath` | Path to `master_data.json` (suppliers, employees, cost centres, GL accounts, FX rates) |
| `poApiUrl` | Base URL of the mock PO API |
| `thresholds.autoConfidence` | Minimum field confidence to auto-submit (default 0.80) |
| `thresholds.clarifyFloor` | Below this confidence → clarification request (default 0.50) |
| `thresholds.defaultDeliveryLeadDays` | Lead time for explicitly flexible requests ("whenever you can") |
| `models.extraction` | Anthropic model ID for the extraction step |

## Pipeline overview

1. **Ingest** — parse `.eml` (headers, body, attachments)
2. **Extract** — send email text + PDF document blocks to the LLM; validate response against a Zod schema; retry once with the validation error on failure
3. **Resolve** — fuzzy-match supplier, cost centre, employee, GL account against master data; compute CHF total using master-data FX rates
4. **Approve** — deterministic approval chain from the CHF total and cost-centre department
5. **Decide** — route to `submitted`, `needs_clarification`, `needs_human_review`, or `security`
6. **Submit** — POST to the mock PO API; record everything in the SQLite audit log

## src layout

```
src/
  pipeline.ts       top-level orchestrator
  cli.ts / demo.ts / eval.ts / eval-core.ts   entry points
  types.ts / schema.ts / config.ts / db.ts    shared foundations

  ingest/           email parsing (ingest.ts) and PDF attachment handling (attachments.ts)
  extraction/       LLM extraction call and response parsing (extract.ts)
  resolution/       master-data matching: resolve.ts, approvals.ts, delivery.ts, fx.ts
  decision/         routing logic (decide.ts)
  output/           PO API call (submit.ts) and SQLite audit log (audit.ts)
  llm/              LLM client interface, Anthropic adapter, token pricing
```

## Assumptions

These are documented in full in [docs/decisions.md](docs/decisions.md). Short version:

| # | Assumption |
|---|---|
| A1 | Approval band gaps: a total above a band's ceiling moves to the next band (D18) |
| A2 | CHF total: VAT/shipping/discounts not yet specified — open question |
| A3 | FX: single rate from `master_data.json`, rounded once at the total (D19) |
| A4 | Missing data: draft a clarification reply and flag for the clerk |
| A5 | PO timing relative to approvals: open question |
| A6 | Self-approval and duplicate roles: keep the step, flag `requiresAlternate`, route to human review (D27) |
| A7 | Duplicate emails: idempotent — same email never creates two POs (D17) |
| A8 | Vague delivery timing: explicit and resolvable-relative → concrete date; flexible low-urgency → standard lead time; high-urgency and silence → clarification (D28/D29/D32) |
