import type { Extraction } from '../schema';
import type { FullResolution } from '../resolution/resolve';
import type { Decision, ReviewReason } from '../types';

export interface Thresholds {
  autoConfidence: number;
  clarifyFloor: number;
}

// The required fields that drive the weakest-link confidence score (D16).
const REQUIRED_CONFIDENCE_FIELDS = [
  'requester_name',
  'requester_email',
  'supplier_name',
  'currency',
  'line_items',
] as const;

function overallConfidence(extraction: Extraction): number {
  const scores = REQUIRED_CONFIDENCE_FIELDS.map(
    f => extraction.field_confidence[f] ?? 0,
  );
  return Math.min(...scores);
}

// Decides the processing status for a requisition.
//
// Priority order (first matching rule wins for security; otherwise all reasons
// are collected and the worst queue wins):
//   1. instructions_to_reader populated → security (short-circuit)
//   2. Supplier issues, chain failures → human queue
//   3. Missing delivery date, cost centre, empty items → clarification queue
//   4. Confidence gate → human (< clarifyFloor) or clarification (< autoConfidence)
//   5. No reasons → ready
export function decide(
  extraction: Extraction,
  resolution: FullResolution,
  thresholds: Thresholds,
): Decision {
  // 1. Social-engineering / prompt-injection defence (D13).
  //    The LLM was instructed to quarantine directives aimed at the processor.
  //    Any non-empty value means the email contains something suspicious.
  if (extraction.instructions_to_reader?.trim()) {
    return {
      status:  'security',
      reasons: [{
        code:   'security_flag',
        queue:  'security',
        detail: extraction.instructions_to_reader.trim(),
      }],
    };
  }

  const reasons: ReviewReason[] = [];

  // 2a. Supplier issues
  if (!resolution.supplier?.match) {
    reasons.push({ code: 'unknown_supplier', queue: 'human',
      detail: `No supplier match for "${extraction.supplier_name}"` });
  } else if (resolution.supplier.match.status === 'blocked') {
    reasons.push({ code: 'blocked_supplier', queue: 'human',
      detail: `${resolution.supplier.match.id} is blocked` });
  } else if (resolution.supplier.ambiguous) {
    reasons.push({ code: 'ambiguous_supplier', queue: 'human',
      detail: `"${extraction.supplier_name}" matches multiple suppliers` });
  }

  // 2b. Approval chain
  if (!resolution.chain) {
    // No chain means no cost centre was resolved — clarification, not human review,
    // because the user might have simply omitted it.
    reasons.push({ code: 'missing_cost_centre', queue: 'clarification',
      detail: 'Cost centre not identified' });
  } else if (!resolution.chain.ok) {
    reasons.push({ code: 'no_approval_chain', queue: 'human',
      detail: resolution.chain.reason });
  }

  // 3a. Empty line items
  if (!extraction.line_items?.length) {
    reasons.push({ code: 'no_line_items', queue: 'clarification',
      detail: 'No line items found in the requisition' });
  }

  // 3b. Delivery requirement.
  //     A usable date (explicit, or a relative timeframe resolved deterministically
  //     against the email date) satisfies this. Pure urgency ("ASAP") or silence
  //     yields no date — and we never invent one — so it routes to clarification.
  const delivery = resolution.delivery;
  if (!delivery || delivery.date == null) {
    const urgent = delivery?.kind === 'urgency' || delivery?.urgency === 'high';
    reasons.push({
      code:   'missing_delivery_date',
      queue:  'clarification',
      detail: urgent
        ? `Delivery urgency expressed${delivery?.timeframe ? ` ("${delivery.timeframe}")` : ''} but no concrete date — please confirm a required delivery date`
        : 'No delivery date specified',
    });
  }

  // 4. Confidence gate
  const confidence = overallConfidence(extraction);
  if (confidence < thresholds.clarifyFloor) {
    reasons.push({ code: 'low_confidence', queue: 'human',
      detail: `Confidence ${confidence.toFixed(2)} < clarification floor ${thresholds.clarifyFloor}` });
  } else if (confidence < thresholds.autoConfidence) {
    reasons.push({ code: 'low_confidence', queue: 'clarification',
      detail: `Confidence ${confidence.toFixed(2)} < auto threshold ${thresholds.autoConfidence}` });
  }

  // 5. Ready
  if (reasons.length === 0) {
    return { status: 'ready', reasons: [] };
  }

  // Any human-queue reason escalates the whole requisition to human review.
  if (reasons.some(r => r.queue === 'human')) {
    return { status: 'needs_human_review', reasons };
  }

  return {
    status:     'needs_clarification',
    reasons,
    draftReply: buildDraftReply(extraction, reasons),
  };
}

function buildDraftReply(extraction: Extraction, reasons: ReviewReason[]): string {
  const name     = extraction.requester_name ?? extraction.requester_email ?? 'Requester';
  const supplier = extraction.supplier_name  ?? 'the supplier';

  const items = reasons.map(r => {
    switch (r.code) {
      case 'missing_delivery_date':
        return r.detail.includes('urgency')
          ? '• Required delivery date (you flagged this as urgent — we will prioritise once confirmed)'
          : '• Required delivery date';
      case 'missing_cost_centre':   return '• Cost centre (e.g. CC-1001 — Plant Maintenance)';
      case 'no_line_items':         return '• Line item details: description, quantity, and unit price';
      case 'low_confidence':        return '• Please clarify any ambiguous fields in your request';
      default:                      return `• ${r.detail}`;
    }
  }).join('\n');

  return (
    `Subject: Re: Purchase Requisition — ${supplier} — Additional information needed\n\n` +
    `Dear ${name},\n\n` +
    `Thank you for your purchase requisition. To process your request, we need the following:\n\n` +
    `${items}\n\n` +
    `Please reply with this information and we will process your order promptly.\n\n` +
    `Kind regards,\nPurchasing Team`
  );
}
