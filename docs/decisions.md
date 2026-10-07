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
| D7 | The LLM only extracts structured fields; approval routing, FX conversion, thresholds and master-data resolution are deterministic, tested code | Proposed | Predictable, testable, auditable; a wrong approval chain is the worst failure | Letting the LLM decide approvals end to end |
| D8 | All model calls go through one `LlmClient` interface; provider and model per task set in config | Proposed | Swapping models is a config change, swapping providers one adapter; logs cost and latency per call | Direct SDK calls throughout the code |
| D9 | Send PDFs directly to the model as documents, with page limits and a cost cap | Proposed | No local PDF parser to maintain or explain; handles layouts and scans | Local text extraction plus a vision fallback |
| D10 | Validate every LLM output with a schema (Zod); on failure retry once with the error, then send to a human review queue | Proposed | The system never crashes on bad output and never guesses | Trusting the model output |
| D11 | Low confidence, missing required data or ambiguous matches go to review or a drafted clarification reply, never auto-approved | Proposed | Zero wrong auto-approvals is the key quality metric | Best-guess filling |
| D12 | SQLite for state and the audit log | Proposed | Simple and auditable at this scale; Postgres plus a queue at 500+/day | Files only; Postgres from the start |
| D13 | Treat email and attachment content as untrusted data (prompt-injection defence) | Proposed | Emails come from outside the pipeline | None |
| D14 | Own eval set of about 15 hand-labeled emails: field accuracy, approval-chain correctness, review share, cost and latency | Proposed | Gives numbers for the walkthrough and a safe way to compare models | Judging by eye |
| D15 | LLM provider and key | Open | I need to confirm I have an API key and spending limit set up, and keep it in `.env` | Another provider behind the same interface |

## Assumptions about the spec

Fill these in as they are resolved. Reference the number in code comments and commit messages.

| # | Question | Current default | Status |
|---|---|---|---|
| A1 | The approval table has gaps between ranges (e.g. 1,000.50 is neither ≤1,000 nor ≥1,001). Which band applies? | Anything above a band's upper limit moves to the next band (so 1,000.01 requires the second band) | Proposed; asked the interviewers |
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
