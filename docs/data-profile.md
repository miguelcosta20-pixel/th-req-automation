# Data Profile

> Factual survey of every data source in `data/` and `tools/`.  
> No application code written yet. Open questions listed at the end.

---

## 1. `tools/mock_po_api.py`

### 1.1 Runtime

| Property | Value |
|---|---|
| Language | Python 3.9+, stdlib only |
| Default bind | `127.0.0.1:8080` (localhost, not externally reachable) |
| Storage | In-memory `dict`; optionally persisted to a JSON file via `python3 mock_po_api.py 8080 orders.json` |
| Concurrency | `ThreadingHTTPServer`, queue 128, daemon threads, 30 s idle timeout |
| Authentication | **None** — no API key, no token, no IP allowlist |
| Body size limit | 5 MiB |

### 1.2 Endpoints

| Method | Path | Success | Notes |
|---|---|---|---|
| GET | `/health` | 200 `{"status":"ok","orders":<n>}` | Liveness probe |
| GET | `/purchase-orders` | 200 `[…]` | Returns every order booked so far |
| GET | `/purchase-orders/PO-YYYY-NNNN` | 200 `{order}` | 404 if unknown |
| POST | `/purchase-orders` | 201 `{order}` | Books a new PO; see schema below |
| OPTIONS | `*` | 204 | CORS preflight |
| PUT/DELETE/PATCH | any | 405 | Method not allowed |

CORS headers are sent on every response (`Access-Control-Allow-Origin: *`).

### 1.3 POST `/purchase-orders` — Request Schema

**Header**

| Header | Required | Notes |
|---|---|---|
| `Content-Type` | No | Should be `application/json` |
| `Idempotency-Key` | No | See §1.5 |

**Query parameter**

| Parameter | Effect |
|---|---|
| `?strict=1` | Promotes all warnings to hard errors (returns 422 instead of 201 with warnings) |

**Body — required fields (422 if absent or blank)**

| Field | Type | Constraint |
|---|---|---|
| `supplier_id` | string | Must be a non-blank string; unknown IDs → warning, not error |
| `currency` | string | Must be `CHF`, `EUR`, `USD`, or `GBP` |
| `total` | number | Finite JSON number with decimal dot; not a string, not bool, not `NaN`/`Inf` |
| `requested_delivery_date` | string | YYYY-MM-DD format preferred; bad format → warning, not error |
| `line_items` | array | Non-empty; each item must be an object |

**Per line item — required fields**

| Field | Type | Notes |
|---|---|---|
| `item_name` | string | Free text if no item code |
| `quantity` | number | Must be finite |
| `unit_price` | number | Must be finite |
| `unit` | string | e.g. `"pcs"`, `"m"`, `"kg"` |

**Body — optional advisory fields (absent → warning on 201)**

| Field | Type | Notes |
|---|---|---|
| `cost_centre` | string | British spelling; unknown code → warning |
| `gl_account` | string | Unknown code → warning |

**Body — optional, no warning if absent**

| Field | Type | Notes |
|---|---|---|
| `tax_amount` | number | Used when reconciling total vs. sum of lines |
| `requisition_reference` | string | Falls back to `Idempotency-Key` if absent |
| `line_items[].item_code` | string | Missing → per-line warning; free-text lines are legitimate |

**Response — 201 Created**

```json
{
  "po_number": "PO-2026-0001",
  "status": "created",
  "supplier_id": "SUP-001",
  "currency": "EUR",
  "total": 1751.40,
  "tax_amount": null,
  "requested_delivery_date": "2026-06-30",
  "cost_centre": "CC-1001",
  "gl_account": "5100",
  "line_items": [ … ],
  "requisition_reference": "email_29",
  "idempotency_key": "email_29",
  "warnings": ["line 4: item_code is missing"]
}
```

`po_number` is assigned by the server (`PO-2026-<sequential>`); any `po_number` in the request body is silently ignored.

### 1.4 Validation Rules

| Rule | Outcome |
|---|---|
| Any required field blank/missing | 422 with full list of errors |
| `currency` not in allowed set | 422 |
| `total` or any `quantity`/`unit_price` is bool, string, `NaN`, or `Inf` | 422 |
| `line_items` empty or not an array | 422 |
| `total` does not equal Σ(qty × unit_price) + `tax_amount` within ±0.01 | Warning on 201 (not an error) |
| `requested_delivery_date` not matching `YYYY-MM-DD` | Warning on 201 |
| `supplier_id`, `cost_centre`, or `gl_account` not found in master data | Warning on 201 (master data must be loaded; absence of file disables checks) |
| Unknown `cost_centre` or `gl_account` | Warning on 201 |

All errors are collected and returned together — the server never stops at the first failure.

### 1.5 Idempotency

Send `Idempotency-Key: <unique-string>` in the POST header.

- First call with a given key → 201, order booked and key recorded.
- Repeat call with the **same** key → **200** (not 201), original order returned, no second PO created.
- Without the header → no deduplication; the same email can create multiple POs.

The key is stored in the returned order as `idempotency_key` and is used as `requisition_reference` when no explicit reference is given.

**Implementation implication:** the pipeline must derive a stable, deterministic key from each email (e.g. `hash(message-id + supplier_id + total)`) before posting.

### 1.6 Error Codes

| Code | Meaning |
|---|---|
| 400 | Empty body, invalid JSON, bad `Content-Length`, or body > 5 MiB |
| 404 | Unknown route or unknown PO number |
| 405 | PUT, DELETE, PATCH |
| 422 | Validation failure; body is `{"error":"…","problems":[…],"warnings":[…]}` |
| 500 | Unhandled internal exception (still returns JSON, never drops socket) |

### 1.7 Master Data Integration

When `tools/master_data.json` exists next to the script, the server loads supplier IDs, cost-centre codes, and GL account codes at startup. Unknown values produce warnings (not errors). The server logs the count at startup:

```
Mock PO API on http://127.0.0.1:8080
  master_data.json found: 25 suppliers, 15 cost centres, 12 GL accounts
```

Note: `master_data.json` must be placed in `tools/` (beside the script), not in `data/`.

---

## 2. `data/master_data.json`

### 2.1 Overview

| Table | Key field | Count |
|---|---|---|
| `suppliers` | `id` (`SUP-NNN`) | 25 |
| `cost_centers` | `code` (`CC-NNNN`) | 15 |
| `departments` | `code` (`OPS`, `RND`, …) | 6 |
| `employees` | `id` (`EMP-NNN`) | 36 |
| `approval_limits_chf` | `from` / `to` | 5 bands |
| `gl_accounts` | `code` (`NNNN`) | 12 |
| `_meta.fx_rates_to_chf` | currency code | 4 |

### 2.2 Suppliers

| ID | Name | Country | Currency | Preferred | Status | Notes |
|---|---|---|---|---|---|---|
| SUP-001 | Acme Bearings GmbH | DE | EUR | ✓ | active | Near-duplicate of SUP-006 |
| SUP-002 | SwissElectro AG | CH | CHF | ✓ | active | |
| SUP-003 | Nordic Tools AS | NO | EUR | — | active | |
| SUP-004 | Müller Industriebedarf | DE | EUR | ✓ | active | Near-duplicate of SUP-007 |
| SUP-005 | Office Plus Schweiz | CH | CHF | ✓ | active | |
| SUP-006 | ACME Bearing Group Ltd | GB | GBP | — | active | Near-duplicate of SUP-001 |
| SUP-007 | Mueller Industriebedarf AG | DE | EUR | — | active | Near-duplicate of SUP-004 |
| SUP-008 | Hydraulik Zentrale AG | CH | CHF | ✓ | active | |
| SUP-009 | PrecisionCast Metals Ltd | GB | GBP | — | active | |
| SUP-010 | Kabelwerk Rheintal GmbH | DE | EUR | ✓ | active | |
| SUP-011 | TechnoPlast Kunststoffe GmbH | DE | EUR | — | active | |
| SUP-012 | Global Fastener Supply Inc. | US | USD | — | active | |
| SUP-013 | Bergmann Werkzeugbau KG | DE | EUR | ✓ | active | |
| SUP-014 | Elektro Bühler AG | CH | CHF | ✓ | active | |
| SUP-015 | Sensorik Nord GmbH | DE | EUR | — | active | |
| SUP-016 | Alpine Logistics Services AG | CH | CHF | ✓ | active | |
| SUP-017 | Lombardi Componenti S.r.l. | IT | EUR | — | active | |
| SUP-018 | Baltic Steel Trading OÜ | EE | EUR | — | **blocked** | 🚨 Blocked |
| SUP-019 | Werkstatt Huber | CH | CHF | — | active | `vat_id: null` |
| SUP-020 | Zenith Automation BV | NL | EUR | — | active | |
| SUP-021 | Feinmechanik Tanner GmbH | CH | CHF | ✓ | active | |
| SUP-022 | IndustrieChemie Basel AG | CH | CHF | ✓ | active | |
| SUP-023 | Nihon Seiko Trading Co. | JP | USD | — | active | USD, not JPY |
| SUP-024 | Rapid Prototyping Studio GmbH | DE | EUR | — | active | |
| SUP-025 | Verpackung Schneider GmbH | DE | EUR | ✓ | active | |

**Near-duplicate pairs:**

| Pair | SUP-001 (preferred, DE) | SUP-006 (not preferred, GB) |
|---|---|---|
| Names | Acme Bearings GmbH | ACME Bearing Group Ltd |
| VAT | DE123456789 | GB887766554 |
| Currency | EUR | GBP |
| Comment | Both appear in emails and have separate quotes | Different legal entities; easy to confuse by name |

| Pair | SUP-004 (preferred, DE) | SUP-007 (not preferred, DE) |
|---|---|---|
| Names | Müller Industriebedarf | Mueller Industriebedarf AG |
| VAT | DE445566778 | DE445566779 | 
| Currency | EUR | EUR |
| Comment | VAT IDs differ by one digit; both German; SUP-007 has the "AG" suffix | Most likely a data-entry duplicate or renamed entity |

### 2.3 Cost Centres → Departments → Employees

```
department
  └─ cost_center  (owner_employee_id → employee)
```

| CC Code | Name | Dept | Owner EMP | Owner Name |
|---|---|---|---|---|
| CC-1001 | Plant Maintenance Schorndorf | OPS | EMP-101 | Hans Meier |
| CC-1002 | Production Line A | OPS | EMP-102 | Petra Brunner |
| CC-1003 | Production Line B | OPS | EMP-103 | Daniel Kunz |
| CC-1004 | Toolroom & Fixtures | OPS | EMP-501 | Andrea Roth ⚠️ |
| CC-1005 | Warehouse & Logistics | LOG | EMP-105 | Silvia Moser |
| CC-2001 | R&D Hardware | RND | EMP-201 | Lukas Frei |
| CC-2002 | R&D Test Lab | RND | EMP-202 | Anna Widmer |
| CC-2003 | Product Design | RND | EMP-203 | Fabio Rossi |
| CC-3001 | Office Zurich HQ | G&A | EMP-301 | Sara Keller |
| CC-3002 | Office London | G&A | EMP-302 | James Whitfield |
| CC-3003 | Office Schorndorf | G&A | EMP-303 | Katrin Lehmann |
| CC-4001 | Quality Assurance Lab | QA | EMP-401 | Yves Girard |
| CC-4002 | Metrology | QA | EMP-402 | Corinne Baumann |
| CC-5001 | IT Infrastructure | IT | EMP-451 | Pascal Steiner |
| CC-5002 | IT Software & Licences | IT | EMP-452 | Nina Hofmann |

⚠️ CC-1004's owner (EMP-501, Andrea Roth) is also the department head of OPS. For orders on CC-1004 above CHF 1,000, the approval chain requires both `cost_center_owner` and `department_head` — but both roles belong to the same person. `duplicate_role_collapses: true` means only one sign-off is needed from her, but `self_approval_forbidden: true` means she cannot approve her own purchase requests. This combination needs special handling.

### 2.4 Departments

| Code | Name | Head (EMP) | Head Name |
|---|---|---|---|
| OPS | Operations | EMP-501 | Andrea Roth |
| RND | Research & Development | EMP-502 | Markus Schmid |
| G&A | General & Administrative | EMP-503 | Olivia Tanner |
| QA | Quality Assurance | EMP-504 | Nadia Berger |
| IT | Information Technology | EMP-505 | Stefan Vogel |
| LOG | Logistics | EMP-506 | Marco Bianchi |

### 2.5 Employees

| ID | Name | Email | Role |
|---|---|---|---|
| EMP-101..105, 201..203, 301..303, 401..402, 451..452 | (see table above) | `<name>@customer.com` | cost_center_owner |
| EMP-501..506 | Andrea Roth, Markus Schmid, Olivia Tanner, Nadia Berger, Stefan Vogel, Marco Bianchi | `<name>@customer.com` | department_head |
| EMP-701 | Daniela Huber | daniela.huber@customer.com | finance |
| EMP-702 | Thomas Egger | thomas.egger@customer.com | finance; deputy for EMP-701 |
| EMP-801 | Roger Studer | roger.studer@customer.com | cfo |
| EMP-901 | Beatrice Fischer | beatrice.fischer@customer.com | ceo |
| EMP-110 | Tobias Weber | tobias.weber@customer.com | requester_only, default CC-1001 |
| EMP-111 | Miriam Frick | miriam.frick@customer.com | requester_only, default CC-1002 |
| EMP-112 | Ahmed Nasser | ahmed.nasser@customer.com | requester_only, default CC-1005 |
| EMP-210 | Sophie Dubois | sophie.dubois@customer.com | requester_only, default CC-2002 |
| EMP-310 | Emily Carter | emily.carter@customer.com | requester_only, default CC-3002 |
| EMP-311 | Luca Ferrari | luca.ferrari@customer.com | requester_only, default CC-3001 |
| EMP-410 | Ruedi Zimmermann | ruedi.zimmermann@customer.com | requester_only, default CC-4001 |
| EMP-460 | Oliver Brand | oliver.brand@customer.com | requester_only, default CC-5001 |

### 2.6 Approval Limits (CHF)

| Band | From | To | Required roles |
|---|---|---|---|
| 1 | 0 | 1,000 | cost_center_owner |
| 2 | 1,001 | 10,000 | cost_center_owner + department_head |
| 3 | 10,001 | 50,000 | + finance |
| 4 | 50,001 | 250,000 | + cfo |
| 5 | 250,001 | ∞ | + ceo |

Rules: `self_approval_forbidden: true`, `duplicate_role_collapses: true`, `approvals_are_sequential: true`.

All amounts must be converted to CHF before band lookup.

### 2.7 FX Rates (→ CHF)

| Currency | Rate |
|---|---|
| CHF | 1.00 |
| EUR | 0.96 |
| USD | 0.88 |
| GBP | 1.13 |

GBP is stronger than CHF. A GBP-denominated order will convert to a higher CHF value than its face value.

### 2.8 GL Accounts

| Code | Name |
|---|---|
| 5100 | Maintenance & Repair Materials |
| 5200 | Production Consumables |
| 5300 | Spare Parts |
| 5400 | Tooling & Fixtures |
| 6100 | R&D Hardware |
| 6200 | R&D Consumables & Prototyping |
| 7100 | Office Supplies |
| 7200 | IT Equipment |
| 7300 | Software & Licences |
| 7400 | Lab & Measurement Equipment |
| 7500 | Packaging Material |
| 7600 | Freight & Logistics Services |

### 2.9 Data Quality Issues

| # | Issue | Detail |
|---|---|---|
| DQ-1 | Near-duplicate suppliers | SUP-001/SUP-006 (Acme Bearings GmbH vs ACME Bearing Group Ltd) and SUP-004/SUP-007 (Müller vs Mueller Industriebedarf) — fuzzy matching must not conflate these; they are different legal entities with different countries, VAT IDs, and payment terms |
| DQ-2 | Blocked supplier with active emails | SUP-018 (Baltic Steel Trading OÜ) is `status: "blocked"` but appears as the supplier in email_09 with a quote attached |
| DQ-3 | Supplier with no VAT ID | SUP-019 (Werkstatt Huber) has `"vat_id": null` — a small local workshop; normal, but the pipeline must not treat a null as missing required data |
| DQ-4 | Orphaned employee | EMP-104 (Reto Ammann) has `role: "cost_center_owner"` but no cost centre in the data has `owner_employee_id: "EMP-104"` — he is a cost-center owner with no assigned centre |
| DQ-5 | Dual-role CC owner | CC-1004 owner EMP-501 (Andrea Roth) is also OPS department_head — the approval chain collapses to one person who cannot self-approve |
| DQ-6 | API spelling vs JSON key | The API POST field is `cost_centre` (British, singular); the JSON key in master_data is `cost_centers` (American, plural). The API's `load_master_data()` handles this correctly internally, but the pipeline must use the correct field name when building POST bodies |
| DQ-7 | Approval band boundaries are integers | Bands use `from`/`to` as integers (e.g. 1000 / 1001) but totals are floats. A CHF 1000.50 order falls in band 1 under a strict integer interpretation but arguably in band 2. The boundary condition (0–1000 inclusive vs 1001+) needs a defined rule |
| DQ-8 | No GL account linkage in master data | GL accounts are not linked to cost centres or departments; assignment must be inferred from item type at runtime |

---

## 3. Emails (48 files)

### 3.1 Overview Statistics

| Metric | Count |
|---|---|
| Total email files | 48 (email_38 and email_47 missing from dataset) |
| Language: German (DE) | 27 |
| Language: English (EN) | 21 |
| With real MIME attachment | 20 |
| Fake attachment reference (text placeholder, no MIME part) | 1 (email_01) |
| Embedded supplier quote in forwarded body (no file) | 2 (email_03, email_18) |
| No attachment | 25 |
| Forwards or threads | 4 (email_03, email_18, email_45, email_46) |

### 3.2 Requesters Appearing in Emails

All senders use `@customer.com` addresses. All are found in master data **except**:

- **Reto Ammann** (EMP-104): sends email_08 and email_17; role is `cost_center_owner` but owns no CC in master data (DQ-4 above).
- **Andrea Roth** (EMP-501): department head, appears as requester in email_23 — she orders on CC-1004 which she also owns (self-approval issue for amounts > CHF 1,000).
- **Tobias Weber** (EMP-110): his declared default CC is CC-1001, but he charges to CC-1004 (email_22), CC-2001 (email_41), and CC-3003 (email_27) in various emails.

### 3.3 Issues and Notable Cases

**email_01 — Fake attachment**  
`Content-Type: text/plain`. Body contains the literal string `[Attachment: quote_acme_bearings.pdf]` but there is no MIME multipart structure and no encoded payload. The parser will find no attachment. This tests whether the pipeline correctly handles the case where a referenced quote is not actually present.

**email_04 — Completely unactionable ("das uebliche")**  
Subject: "bitte das uebliche". Supplier is "gleicher Lieferant wie immer" (same as always). Items are "das uebliche fuer Linie A" (the usual for Line A). No supplier name, no items, no quantities, no cost centre. Must route to human review with a request for clarification.

**email_06 — Verbal-only quote**  
Miriam Frick quotes USD 8,400 (Global Fastener Supply) but explicitly states the prices were given "over the phone." No written quote exists. Items and arithmetic are complete but there is no documentary evidence. A deliberate test of documentation requirements.

**email_09 — Blocked supplier**  
Ahmed Nasser requests an order from Baltic Steel Trading OÜ (SUP-018, `status: "blocked"`). The quote is attached and the arithmetic is valid. The pipeline must check supplier status and block submission, routing to human review.

**email_14 — Wrong cost centre for requester**  
Miriam Frick (Production Line B, default CC-1003) charges 7 units at CHF 143 to CC-1002 (Production Line A, owned by Petra Brunner). Subject also says "Linie A." The cross-line order may be legitimate but must be flagged.

**email_18 — Large capex with unverifiable approval claim**  
Sophie Dubois forwards a EUR 118,000 quote from Zenith Automation BV and states it "was agreed in the Q2 capex review." No documentation of this approval is attached. Above CHF 10,001 equivalent (EUR 118k × 0.96 = CHF 113,280) this requires finance + CFO approval regardless of any informal claim.

**email_24 — PDF with wrong total (filename signals it)**  
`quote_kabelwerk_wrong_total.pdf` is attached. The filename is an explicit signal. The PDF states a grand total of EUR 4,830.00 but the subtotal of the two line items is EUR 4,380.00 — a gap of EUR 450.00 with no VAT or freight line to explain it. The pipeline must catch this in quote validation and route to human review.

**email_25 — Per-100 unit pricing**  
`quote_technoplast_per100.pdf` is attached. The PDF unit price is EUR 21.00 **per 100 pieces** ("Preis gilt je 100 Stück"), stated explicitly in the footnote. If the pipeline naively reads the unit price column as per-piece, the computed total will be 100× too high (or the quantity will be 100× too low). The quote is otherwise mathematically correct at the per-100 basis: 15,000 × (21.00/100) = EUR 3,150.00.

**email_28 + email_44 — Duplicate sensor requests**  
Sophie Dubois (email_28, 15 May) requests "roughly ten" IN-M12 sensors from Sensorik Nord for CC-2002, estimating "around EUR 5,000." Anna Widmer (email_44, 15 May) requests 20 IN-M12 sensors from the same supplier for the same CC-2002 but has no quote — she attaches only the technical datasheet (`datasheet_sensorik_nord.pdf`). These are two requests for the same product to the same cost centre from two different people on the same day. Neither has a valid quote; they must be consolidated before ordering.

**email_30 — Correction with no reference**  
Miriam Frick sends: "Korrektur zu meiner letzten Anfrage — es sind 12 nicht 120, der Rest bleibt wie besprochen." No subject-line reference, no quote number, no email ID, no item name. The prior email being corrected cannot be identified programmatically.

**email_31 — Explicitly expired quote (attachment filename signals it)**  
`quote_nordic_expired.pdf` is attached. The quote expired 30.04.2026 — over five months before the email dataset's date range. Sophie Dubois acknowledges the quote "is from April" and claims Nordic confirmed prices verbally, but has no written updated quote. Should not be actioned without a fresh written quote.

**email_39 — Reference to external PO system**  
Petra Brunner: "Nachbestellung wie PR-2026-0412 — gleiche Mengen, gleicher Lieferant." PR-2026-0412 is a purchase request reference that exists outside this dataset (presumably in the ERP). No supplier, items, or prices are given. Entirely unactionable without an ERP lookup.

**email_40 — Non-existent cost centre**  
Luca Ferrari charges CHF 740 to CC-9100. This code does not exist in `master_data.json`. Either a typo or a new CC not yet in the data. Master data lookup will fail; API will emit a warning. Human review required.

**email_44 — Datasheet submitted instead of quote**  
`datasheet_sensorik_nord.pdf` contains no prices. The PDF itself states "Es ist kein Angebot und enthält keine Preise." No PO can be generated without a commercial quote.

**email_45 — Three-level forward chain**  
Sophie Dubois forwards from Lukas Frei who forwarded from Anna Widmer who received the original supplier quote from Jeroen Bakker at Zenith Automation. The actual quote figures (EUR 41,200) are buried four messages deep. The thread parser must handle nested quoted text correctly. The quote itself is mathematically valid and (at time of email) still within its 30-day validity window.

**email_46 — Approval expressed as a reply thread**  
Andrea Roth proposes a purchase in a message to Tobias Weber; Tobias replies with a single sentence: "ja bitte so bestellen." This reply is forwarded to procurement. All item details and the cost centre (CC-1004, CHF 2,600) are only in Andrea's quoted message, not in Tobias's reply. The pipeline must parse the thread to reconstruct the full request.

**email_50 — Social engineering / procurement fraud attempt**  
Subject: "DRINGEND Vorrichtung Linie C — CFO hat zugestimmt." CHF 62,000 to Bergmann Werkzeugbau, no quote attached. Tobias Weber claims Roger Studer (CFO) gave verbal approval that morning and **explicitly instructs procurement not to contact the CFO again**: "Er hat gesagt du sollst ihn nicht mehr fragen." Artificial urgency: "Das muss heute noch raus" (Friday evening). Classic pattern: high value + claimed verbal high-level approval + instruction to block verification + deadline pressure. The pipeline must never act on claimed verbal approvals, and must never comply with instructions not to verify. Route to security-aware human review, not the normal approval queue.

---

## 4. Quotes (21 PDFs)

### 4.1 Overview

All 21 PDFs are **text-layer** (not scanned images); OCR fallback is not required for this dataset, but should be implemented for production.

As of the data-profile date (2026-10-07), every quote validity date has passed. In the context of the email dates (May 2026), most were still valid.

| Metric | Value |
|---|---|
| Text-layer PDFs | 21 of 21 |
| Scanned/image PDFs | 0 |
| Currency: EUR | 11 |
| Currency: CHF | 6 |
| Currency: GBP | 2 |
| Currency: USD | 2 |
| Total mismatch | 1 (`quote_kabelwerk_wrong_total.pdf`) |
| Not a quote (datasheet) | 1 (`datasheet_sensorik_nord.pdf`) |
| Expired at time of email | 2 (`quote_nordic_expired.pdf`, `quote_baltic_steel.pdf`) |
| Swiss VAT 8.1% applied | 3 (SwissElectro ×2, Feinmechanik Tanner FT-26-0774) |
| Swiss VAT missing | 2 (IndustrieChemie, Feinmechanik Tanner FT-26-0912) |
| Blanket/annual order | 1 (`quote_acme_long.pdf`, 24 lines) |
| Discount as negative line | 1 (`quote_verpackung_discount.pdf`) |
| Freight as separate line | 1 (`quote_globalfastener_freight.pdf`) |
| Per-100 unit pricing | 1 (`quote_technoplast_per100.pdf`) |
| Down payment required | 2 (Bergmann fixtures 30%, Nihon Seiko 20%) |
| Zero-price line item | 1 (`quote_industriechemie.pdf`, SDS binder free) |

### 4.2 Per-Quote Summary

| File | Supplier | Currency | Total | Lines | Flags |
|---|---|---|---|---|---|
| `datasheet_sensorik_nord.pdf` | Sensorik Nord GmbH | — | — | — | **Not a quote; no prices** |
| `quote_acme_bearing_group.pdf` | ACME Bearing Group Ltd | GBP | 940.00 | 2 | 0% VAT export; validity expired |
| `quote_acme_bearings.pdf` | Acme Bearings GmbH | EUR | 1,751.40 | 4 | 0% intra-EU; validity expired |
| `quote_acme_long.pdf` | Acme Bearings GmbH | EUR | 78,000.00 | 24 (2 pages) | Annual blanket order; validity expired |
| `quote_baltic_steel.pdf` | Baltic Steel Trading OÜ | EUR | 22,000.00 | 2 | 14-day validity; **supplier blocked**; validity expired |
| `quote_bergmann_fixtures.pdf` | Bergmann Werkzeugbau KG | EUR | 52,000.00 | 3 | 30% down payment; validity expired |
| `quote_bergmann_tooling.pdf` | Bergmann Werkzeugbau KG | EUR | 10,400.00 | 3 | Validity expired |
| `quote_feinmechanik_tanner.pdf` | Feinmechanik Tanner GmbH | CHF | 308,085.00 | 4 | Swiss VAT 8.1% (CHF 23,085); highest CHF quote; validity expired |
| `quote_globalfastener_freight.pdf` | Global Fastener Supply Inc. | USD | 9,740.00 | 3 | Freight USD 640 as explicit line; validity expired |
| `quote_industriechemie.pdf` | IndustrieChemie Basel AG | CHF | 6,400.00 | 3 | **No VAT line** (Swiss domestic); zero-price line 3; validity expired |
| `quote_kabelwerk_wrong_total.pdf` | Kabelwerk Rheintal GmbH | EUR | **4,830.00** | 2 | **Total mismatch: lines sum to 4,380.00, gap of +450.00 unexplained** |
| `quote_lombardi.pdf` | Lombardi Componenti S.r.l. | EUR | 12,400.00 | 2 | No delivery date; 60-day payment; validity expired |
| `quote_mueller_industriebedarf.pdf` | Mueller Industriebedarf AG | EUR | 6,100.00 | 4 | Validity expired |
| `quote_nihon_seiko.pdf` | Nihon Seiko Trading Co. | USD | 340,000.00 | 3 | Japanese supplier in USD; highest-value quote; 20% down payment; validity expired |
| `quote_nordic_expired.pdf` | Nordic Tools AS | EUR | 19,450.00 | 4 | **Expired 30.04.2026**; Norwegian supplier incorrectly uses "intra-EU supply" VAT label |
| `quote_precisioncast.pdf` | PrecisionCast Metals Ltd | GBP | 8,900.00 | 3 | Tooling stays supplier property unless bought separately; validity expired |
| `quote_swisselectro.pdf` | SwissElectro AG | CHF | 16,052.85 | 1 | Swiss VAT 8.1% (CHF 1,202.85); validity expired |
| `quote_swisselectro_scx220.pdf` | SwissElectro AG | CHF | 10,485.70 | 2 | Swiss VAT 8.1% (CHF 785.70); validity expired |
| `quote_tanner_messmittel.pdf` | Feinmechanik Tanner GmbH | CHF | 19,080.00 | 4 | **No MwSt line** (inconsistent with FT-26-0774 from same supplier); validity expired |
| `quote_technoplast_per100.pdf` | TechnoPlast Kunststoffe GmbH | EUR | 3,150.00 | 1 | **Unit price EUR 21.00 per 100 pcs** ("Preis gilt je 100 Stück"); validity expired |
| `quote_verpackung_discount.pdf` | Verpackung Schneider GmbH | EUR | 5,600.00 | 3 | Discount −EUR 900 as negative line item; discount conditional on annual volume |

### 4.3 Arithmetic Verification

All quoted totals match their line items **except one**:

**`quote_kabelwerk_wrong_total.pdf`**

| Line | Description | Qty | Unit price | Line total |
|---|---|---|---|---|
| 1 | Control cable LiYCY 4×0.5 | 600 m | EUR 2.30 | EUR 1,380.00 |
| 2 | Cable carrier CK-40 assembled | 200 m | EUR 15.00 | EUR 3,000.00 |
| Subtotal | | | | EUR 4,380.00 |
| Grand total (stated) | | | | **EUR 4,830.00** |
| **Gap** | | | | **+EUR 450.00 — unexplained** |

No VAT line, no freight line, no note. The total cannot be trusted.

---

## 5. Email Reference Table

| File | Language | Attachment | Difficulty | Notable Issue |
|---|---|---|---|---|
| email_01 | DE | fake (text placeholder, no MIME) | Medium | No real attachment; all item details missing |
| email_02 | EN | No | Easy | No CC code; no unit price; "or equivalent" spec |
| email_03 | EN | No (supplier quote in forward body) | Medium | Forward from Nordic Tools; negotiation requested before PO |
| email_04 | DE | No | Hard | "Das uebliche" — no supplier, no items, no qty, no CC |
| email_05 | DE | Yes — quote_swisselectro_scx220.pdf | Easy | Clean; all details in PDF |
| email_06 | EN | No | Medium | Verbal-only quote; no written evidence; USD |
| email_07 | DE | Yes — quote_acme_bearing_group.pdf | Easy | Clean; all details in PDF |
| email_08 | DE | No | Medium | Reto Ammann owns no CC in master data (DQ-4) |
| email_09 | EN | Yes — quote_baltic_steel.pdf | Hard | **Blocked supplier** (SUP-018) |
| email_10 | DE | No | Easy | No formal quote; CHF 480 |
| email_11 | DE | Yes — quote_mueller_industriebedarf.pdf | Medium | Split delivery requested (motor urgent, rest later) |
| email_12 | EN | No | Easy | No product spec, no quote; CHF 999 (under band-1 limit) |
| email_13 | EN | No | Easy | CHF 1,000 (at band-1 ceiling); no quote |
| email_14 | DE | No | Medium | Line B requester on Line A cost centre (CC-1002) |
| email_15 | EN | Yes — quote_precisioncast.pdf | Easy | Clean; all details in PDF |
| email_16 | DE | Yes — quote_bergmann_tooling.pdf | Easy | Clean; all details in PDF |
| email_17 | DE | Yes — quote_bergmann_fixtures.pdf | Medium | Clean quote; 30% down payment; tight delivery ("knapp") |
| email_18 | EN | No (Zenith quote in forward body) | Hard | EUR 118k; capex approval claim unverifiable; needs finance+CFO |
| email_19 | EN | Yes — quote_nihon_seiko.pdf | Hard | USD 340k capex; FOB Yokohama; order timing driven by lead time |
| email_20 | DE | Yes — quote_feinmechanik_tanner.pdf | Hard | CHF 308,085 (incl. VAT); needs finance+CFO+CEO approval |
| email_21 | DE | No | Easy | CHF 2,400; no quote but prices itemised |
| email_22 | DE | No | Medium | Tobias Weber on CC-1004 (unusual; normally CC-1001) |
| email_23 | DE | No | Medium | Andrea Roth (dept head) as requester on her own CC-1004 |
| email_24 | EN | Yes — quote_kabelwerk_wrong_total.pdf | Hard | **PDF total wrong by EUR 450** |
| email_25 | DE | Yes — quote_technoplast_per100.pdf | Hard | **EUR 21.00 per 100 pcs**: factor-of-100 ambiguity |
| email_26 | EN | No | Easy | Clean; EUR 2,100; arithmetic confirmed |
| email_27 | DE | No | Medium | No price; no quote; Tobias on CC-3003 |
| email_28 | EN | No | Hard | Approx qty ("roughly ten") and price ("around EUR 5,000"); **duplicate request with email_44** |
| email_29 | DE | Yes — quote_acme_bearings.pdf | Easy | Hans Meier on CC-1002 (not his default CC-1001) |
| email_30 | DE | No | Hard | Correction ("12 not 120") with no reference to original email |
| email_31 | EN | Yes — quote_nordic_expired.pdf | Hard | Quote expired 30.04.2026; verbal price confirmation only |
| email_32 | EN | Yes — quote_lombardi.pdf | Medium | No delivery date in email or PDF |
| email_33 | DE | No | Easy | Urgent but clean; CHF 1,800 |
| email_34 | EN | Yes — quote_industriechemie.pdf | Medium | Zero-price line item (SDS binder, intentionally free) |
| email_35 | DE | Yes — quote_verpackung_discount.pdf | Medium | Discount conditional on annual volume (requester self-asserts) |
| email_36 | EN | Yes — quote_globalfastener_freight.pdf | Medium | Air freight USD 640 as explicit separate line |
| email_37 | DE | Yes — quote_acme_long.pdf | Hard | Annual blanket order; 24-line PDF; call-off structure |
| email_39 | DE | No | Hard | References prior order PR-2026-0412; no supplier, no items, no prices |
| email_40 | EN | No | Medium | CC-9100 does not exist in master data |
| email_41 | DE | No | Medium | Tobias on CC-2001 (R&D); acknowledged by requester |
| email_42 | EN | No | Hard | 12-month framework commitment (CHF 14,000); needs contract, not standard PO |
| email_43 | EN | No | Easy | Clean; CHF 8,500; all prices in email |
| email_44 | DE | Yes — datasheet_sensorik_nord.pdf | Hard | **Datasheet, not a quote** (no prices); **duplicate with email_28** |
| email_45 | EN | No (quote in 3-level forward body) | Hard | Three-level forward chain; quote still valid; EUR 41,200 |
| email_46 | DE | No (thread reply) | Medium | Approval as reply ("ja bitte so bestellen"); items only in quoted thread |
| email_48 | EN | No | Easy | From stock sheet; prices itemised; EUR 7,450 |
| email_49 | DE | Yes — quote_tanner_messmittel.pdf | Easy | Clean; all details in PDF; CHF 19,080 (no VAT in PDF) |
| email_50 | DE | No | **Critical** | **Social engineering**: CHF 62k, claimed verbal CFO approval, instruction not to verify, Friday urgency |

---

## 6. Open Questions

These ambiguities cannot be resolved from the data alone.

| # | Area | Question |
|---|---|---|
| OQ-1 | Approval bands | The `from`/`to` fields are integers but totals are floats. How should a CHF 1000.50 order be treated? (Band 1 or Band 2?) Recommend: use `total > band.to` so 1000.50 > 1000 → band 2. |
| OQ-2 | Approval bands | The top band has `"to": null`. The code must handle this sentinel value explicitly. |
| OQ-3 | CC-1004 self-approval | CC-1004 owner (EMP-501, Andrea Roth) is also OPS department head. For her own purchase requests on CC-1004 above CHF 1,000, `self_approval_forbidden` blocks her from approving her own request at the `cost_center_owner` step. Who is the fallback approver? |
| OQ-4 | EMP-104 (Reto Ammann) | He is listed as `cost_center_owner` but owns no CC. When he sends a request, which CC owner should approve? His emails use CC-1004. Should the pipeline treat his default as CC-1004 and route accordingly? |
| OQ-5 | Blocked supplier (email_09) | When a supplier is blocked, should the email be returned to the requester with an explanation, silently dropped, or held for manual override? |
| OQ-6 | Expired quotes | All 21 quotes have validity dates in the past (relative to the real calendar date). Should the pipeline reject expired quotes outright, warn and hold for human review, or ignore validity dates (since the exercise emails were written for May 2026)? |
| OQ-7 | email_30 (correction) | The pipeline has no way to link "12 not 120" to a prior email. Should corrections always be routed to human review? Is there a minimum message format required for corrections? |
| OQ-8 | email_39 (PR reference) | PR-2026-0412 is presumably in the ERP. Is there an API to look up prior purchase requests, or should this always route to human review? |
| OQ-9 | email_37 (blanket order) | Annual blanket orders create a single PO covering multiple future call-offs. The mock API does not model call-off schedules. Should a blanket order create one PO for the total, or one per call-off delivery? |
| OQ-10 | Tanner MwSt inconsistency | `quote_tanner_messmittel.pdf` (FT-26-0912, CHF 19,080) shows no MwSt line, while `quote_feinmechanik_tanner.pdf` (FT-26-0774, CHF 285,000 net) correctly shows 8.1%. Is the omission intentional (e.g. the instruments are exported and zero-rated) or a data error? The pipeline should not silently assume a zero-rate for Swiss-domestic suppliers. |
| OQ-11 | IndustrieChemie no VAT | `quote_industriechemie.pdf` also has no MwSt line for a Swiss-domestic supplier. Same question as OQ-10. |
| OQ-12 | quote_nordic_expired.pdf — VAT label | Nordic Tools AS (Norway) uses "intra-EU supply" as the VAT exemption. Norway is EEA/EFTA, not EU. Is this a test of whether the pipeline validates VAT treatment, or simply a data error to be noted? |
| OQ-13 | email_06 — verbal quote | Should a verbal-only quote be rejected immediately (no written evidence policy), or should the pipeline ask the requester to obtain a written confirmation? |
| OQ-14 | email_42 — framework contract | A 12-month service agreement (Alpine Logistics, CHF 14,000) likely needs a contract, not a purchase order. Does the pipeline scope include contract creation, or does it route service agreements to human review? |
| OQ-15 | email_44 + email_28 — duplicate sensors | Once detected as a duplicate request, should the pipeline merge them into a single consolidated order request, or flag both for human decision? |
| OQ-16 | per-100 pricing (email_25) | When a quote PDF states "Preis gilt je 100 Stück," should the LLM extraction normalise the unit price to per-piece before populating the schema, or preserve the per-100 price and carry the pricing unit explicitly? The API schema has no "pricing UOM" field separate from "unit." |
| OQ-17 | email_50 — fraud routing | Should email_50 be flagged as a potential fraud attempt in the audit log and alerted separately from a normal "needs-human-review" status? What is the escalation path? |
| OQ-18 | Missing emails 38 and 47 | Files email_38.eml and email_47.eml do not exist in the dataset. Is this intentional (test for gap handling) or an accidental omission? |
| OQ-19 | Capex approval (emails 18, 19) | Emails 18 and 19 claim capex plan approval. Is there an external system (capex tracker, budget system) whose approval the pipeline should verify, or is this always a human-review item? |
| OQ-20 | `tax_amount` in API vs. VAT in quotes | Swiss quotes include 8.1% MwSt in the grand total. Should `total` in the API POST be the gross amount (incl. VAT) and `tax_amount` set to the VAT component, or should `total` be the net and `tax_amount` absent? The API warns if total ≠ Σ lines but does not mandate a specific convention. |
