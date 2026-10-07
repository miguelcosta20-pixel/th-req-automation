import { PoRequestSchema, PoResponseSchema } from './schema';
import type { Extraction, PoResponse } from './schema';
import type { FullResolution } from './resolve';

export interface SubmitResult {
  poNumber:  string;
  status:    string;
  warnings?: string[];
}

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

  const lineItems = (extraction.line_items ?? [])
    .filter(item => item.description && item.quantity != null && item.unit_price != null)
    .map(item => ({
      item_name:  item.description,
      quantity:   item.quantity!,
      unit_price: item.unit_price!,
      unit:       item.unit ?? 'pcs',
    }));

  const body = PoRequestSchema.parse({
    supplier_id:             supplier.id,
    currency:                resolution.currency,
    total:                   resolution.computedTotalChf,
    requested_delivery_date: extraction.delivery_date!,
    line_items:              lineItems,
    cost_centre:             resolution.costCentre?.match?.code,
    requisition_reference:   idempotencyKey.slice(0, 40),
  });

  const response = await fetch(`${apiUrl}/purchase-orders`, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
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
