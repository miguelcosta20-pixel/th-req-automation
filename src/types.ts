// Shared pipeline types that cross module boundaries.

import type { Extraction } from './schema';

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  sha256: string;
}

export interface ParsedEmail {
  messageId: string;
  from: { name?: string; address?: string };
  subject: string;
  textBody: string;
  htmlBody: string;
  receivedAt: Date;
  attachments: ParsedAttachment[];
}

// LLM document block (Anthropic PDF format). Defined here so both
// attachments.ts and llm/client.ts can reference the same type.
export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
  title?: string;
}

// Per-call record written to the DB after every LLM completion.
export interface LlmCallRecord {
  promptVersion: string;
  model: string;
  inputSha256: string;
  outputText: string;
  parseError: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costChf: number;
  attempt: number;
  success: boolean;
}

// Reason a requisition was not auto-submitted.
export interface ReviewReason {
  code: string;
  queue: 'clarification' | 'human' | 'security';
  detail: string;
}

// Final outcome of decide().
export interface Decision {
  status: 'ready' | 'needs_clarification' | 'needs_human_review' | 'security';
  reasons: ReviewReason[];
  draftReply?: string;
}

// What the pipeline returns for each email.
export interface ProcessResult {
  status: 'submitted' | 'needs_clarification' | 'needs_human_review' | 'security' | 'duplicate' | 'failed';
  emailPath: string;
  messageId?: string;
  poNumber?: string;
  totalChf?: number;
  supplier?: string;
  reasons?: ReviewReason[];
  draftReply?: string;
  error?: string;
  // Diagnostic fields populated after resolution; used by eval harness.
  supplierId?: string;
  costCentreCode?: string;
  currency?: string;
  approvalChainIds?: string[];
  hasDeliveryDate?: boolean;
  lineItemCount?: number;
}

// Rich intermediate result returned by analyzeEml() for the demo page.
export interface DemoResult {
  messageId: string;
  emailInfo: { subject: string; from: string };
  extraction: Extraction | null;
  resolution: {
    supplier:        { id: string | null; name: string | null; score: number; ambiguous: boolean; blocked: boolean } | null;
    costCentre:      { code: string | null; name: string | null; score: number } | null;
    requester:       { id: string | null; name: string | null } | null;
    totalChf:        number;
    currency:        string;
    chain:           Array<{ employeeId: string; name: string; email: string; role: string }> | null;
    chainOk:         boolean;
    chainFailReason: string | null;
  } | null;
  decision: { status: string; reasons: ReviewReason[]; draftReply?: string } | null;
  po:     { poNumber: string; status: string; warnings?: string[] } | null;
  llm:    { model: string; tokensIn: number; tokensOut: number; costChf: number; latencyMs: number } | null;
  dryRun: boolean;
  totalMs: number;
  error?: string;
}
