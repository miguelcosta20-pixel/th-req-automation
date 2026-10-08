import { PoRequestSchema, PoResponseSchema } from '../schema';
import type { Extraction, PoResponse } from '../schema';
import type { FullResolution } from '../resolution/resolve';
import { effectiveUnitPrice } from '../resolution/resolve';

export interface SubmitResult {
  poNumber:  string;
  status:    string;
  warnings?: string[];
}

interface PoLine {
  item_name:  string;
  quantity:   number;
  unit_price: number;
  unit:       string;
  item_code?: string;
}

// Builds the PO line items and the document total in the transaction currency.
//
// The PO is a document in the supplier's/quote currency (D30): the total is the
// sum of the lines in that currency, so it reconciles with what the ERP computes
// (no FX mix). CHF conversion stays internal to approval routing and is NOT the
// PO total. `unit_price` is the effective per-unit price — the per_100 basis is
// applied here so each line's quantity × unit_price matches the stated amount,
// and an `item_code` is carried through when the line stated one.
export function buildPoLines(extraction: Extraction): { lineItems: PoLine[]; total: number } {
  const lineItems: PoLine[] = (extraction.line_items ?? [])
    .filter(item => item.description && item.quantity != null && item.unit_price != null)
    .map(item => {
      const line: PoLine = {
        item_name:  item.description,
        quantity:   item.quantity!,
        unit_price: effectiveUnitPrice(item.unit_price!, item.price_basis),
        unit:       item.unit ?? 'pcs',
      };
      if (item.item_code) line.item_code = item.item_code;
      return line;
    });

  const total = Math.round(lineItems.reduce((s, l) => s + l.quantity * l.unit_price, 0) * 100) / 100;
  return { lineItems, total };
}

// The mock PO API runs locally; 15 s is generous. Without a signal, a hung
// HTTP call would block the entire run-all loop indefinitely.
const PO_API_TIMEOUT_MS = 15_000;

// Posts a purchase order to the mock API with idempotency protection.
// The caller must ensure resolution.supplier.match is non-null (decided by decide()).
// Returns the assigned PO number and any warnings from the API.
export async function submitPO(
  apiUrl:          string,
  resolution:      FullResolution,
  extraction:      Extraction,
  idempotencyKey:  string,
): Promise<SubmitResult> {
  const supplier = resolution.supplier?.match;
  if (!supplier) throw new Error('submitPO called without a resolved supplier');

  const deliveryDate = resolution.delivery?.date;
  if (!deliveryDate) throw new Error('submitPO called without a resolved delivery date');

  const { lineItems, total } = buildPoLines(extraction);

  // GL account is advisory and inferred (not stated in the email), so only send
  // it on an unambiguous category match — otherwise leave it for the ERP / a human.
  const gl = resolution.glAccount;
  const glAccount = gl?.match && !gl.ambiguous ? gl.match.code : undefined;

  const body = PoRequestSchema.parse({
    supplier_id:             supplier.id,
    currency:                resolution.currency,
    total,
    requested_delivery_date: deliveryDate,
    line_items:              lineItems,
    cost_centre:             resolution.costCentre?.match?.code,
    gl_account:              glAccount,
    requisition_reference:   idempotencyKey.slice(0, 40),
  });

  const response = await fetch(`${apiUrl}/purchase-orders`, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(PO_API_TIMEOUT_MS),
  });

  const data = await response.json() as Record<string, unknown>;

  if (response.status === 422) {
    const problems = (data.problems as string[] | undefined) ?? [];
    throw new Error(`PO API rejected: ${problems.join('; ') || JSON.stringify(data)}`);
  }
  if (response.status >= 400) {
    throw new Error(`PO API error ${response.status}: ${JSON.stringify(data)}`);
  }

  const po = PoResponseSchema.parse(data) as PoResponse & { warnings?: string[] };

  return {
    poNumber:  po.po_number,
    status:    po.status,
    warnings:  po.warnings,
  };
}
