import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createHash } from 'crypto';
import { ExtractionSchema } from '../schema';
import { computeCostChf } from '../llm/pricing';
import type { LlmClient, LlmRequest, ContentBlock } from '../llm/client';
import type { ParsedEmail, DocumentBlock, LlmCallRecord } from '../types';
import type { Extraction } from '../schema';

// Resolved once at module load — prompts/ sits two levels above src/extraction/.
const PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
  'prompts',
  'extract.v2.md',
);

// Derived from the filename so the log version stays in sync with the file.
const PROMPT_VERSION = basename(PROMPT_PATH, '.md');

export function loadSystemPrompt(): string {
  return readFileSync(PROMPT_PATH, 'utf-8');
}

export interface ExtractResult {
  extraction: Extraction | null;
  calls: LlmCallRecord[];
}

// Extracts structured fields from a parsed email + optional PDF document blocks.
// Attempts once, retries once with the validation error if the response is
// invalid JSON or fails Zod validation. Returns null if both attempts fail.
export async function extractFromEmail(
  email: ParsedEmail,
  documentBlocks: DocumentBlock[],
  client: LlmClient,
  systemPrompt: string,
  model: string,
): Promise<ExtractResult> {
  const firstUserContent: ContentBlock[] = [
    { type: 'text', text: formatEmailText(email) },
    ...documentBlocks,
  ];

  return extractWithRetry(firstUserContent, client, systemPrompt, model);
}

// Merges a correction email onto the ORIGINAL requisition's already-extracted
// structured data (not the original's raw email). Using the stored extraction
// means line items that originally came from a PDF, or from an earlier
// correction in a chain, are preserved — re-reading the original email body
// would lose them. The correction's own attachments are still sent, in case the
// correction introduces new document-based line items. Same retry contract as
// extractFromEmail. The caller always routes the result to review.
export async function mergeCorrection(
  originalExtraction: Extraction,
  correctionEmail:    ParsedEmail,
  correctionBlocks:   DocumentBlock[],
  client:             LlmClient,
  systemPrompt:       string,
  model:              string,
): Promise<ExtractResult> {
  const mergeText =
    'MERGE TASK: Apply the CORRECTION to the ORIGINAL requisition and return ONE\n' +
    'final extraction covering the full schema. The ORIGINAL is given as\n' +
    'already-extracted structured JSON. Keep every ORIGINAL value unless the\n' +
    'correction explicitly changes or removes it.\n\n' +
    '===== ORIGINAL (structured JSON) =====\n' +
    JSON.stringify(originalExtraction, null, 2) +
    '\n\n===== CORRECTION (email) =====\n' +
    formatEmailText(correctionEmail);

  const firstUserContent: ContentBlock[] = [
    { type: 'text', text: mergeText },
    ...correctionBlocks,
  ];

  return extractWithRetry(firstUserContent, client, systemPrompt, model);
}

// Shared call+retry machinery. First attempt; on invalid JSON / Zod failure,
// retry once showing the model its own output and the validation error.
async function extractWithRetry(
  firstUserContent: ContentBlock[],
  client:           LlmClient,
  systemPrompt:     string,
  model:            string,
): Promise<ExtractResult> {
  const req1: LlmRequest = {
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: firstUserContent }],
  };

  const { extraction: e1, record: rec1, parseError: err1 } = await callAndParse(
    client, req1, model, 1,
  );
  const calls: LlmCallRecord[] = [rec1];
  if (e1) return { extraction: e1, calls };

  // Retry: show the model its own failed output + the validation error.
  const req2: LlmRequest = {
    model,
    system: systemPrompt,
    messages: [
      { role: 'user',      content: firstUserContent },
      { role: 'assistant', content: [{ type: 'text', text: rec1.outputText }] },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: `Your previous response failed validation with this error:\n\n${err1}\n\nPlease return only the corrected JSON object.`,
        }],
      },
    ],
  };

  const { extraction: e2, record: rec2 } = await callAndParse(client, req2, model, 2);
  calls.push(rec2);

  return { extraction: e2, calls };
}

async function callAndParse(
  client: LlmClient,
  req: LlmRequest,
  model: string,
  attempt: number,
): Promise<{ extraction: Extraction | null; record: LlmCallRecord; parseError: string }> {
  const inputSha256 = createHash('sha256')
    .update(JSON.stringify(req.messages))
    .digest('hex');

  const resp = await client.complete(req);

  const { extraction, parseError } = parseExtraction(resp.text);

  const record: LlmCallRecord = {
    promptVersion: PROMPT_VERSION,
    model: resp.model,
    inputSha256,
    outputText: resp.text,
    parseError,
    latencyMs: resp.latencyMs,
    tokensIn:  resp.usage.tokensIn,
    tokensOut: resp.usage.tokensOut,
    costChf:   computeCostChf(model, resp.usage.tokensIn, resp.usage.tokensOut),
    attempt,
    success:   extraction !== null,
  };

  return { extraction, record, parseError };
}

// Strip markdown fences and find the outermost JSON object in the response.
function parseExtraction(text: string): { extraction: Extraction | null; parseError: string } {
  // 1. Strip ```json ... ``` or ``` ... ``` fences if present
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // 2. Find first { to last }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { extraction: null, parseError: 'No JSON object found in response' };
  }
  const jsonStr = cleaned.slice(start, end + 1);

  // 3. Parse and validate with Zod
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    const result = ExtractionSchema.safeParse(parsed);
    if (result.success) {
      return { extraction: result.data, parseError: '' };
    }
    return {
      extraction: null,
      parseError: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  } catch (e) {
    return {
      extraction: null,
      parseError: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function formatEmailText(email: ParsedEmail): string {
  const from = [email.from.name, email.from.address ? `<${email.from.address}>` : '']
    .filter(Boolean).join(' ');
  const body = email.textBody.trim() || '(empty email body)';

  return [
    `From: ${from || 'unknown'}`,
    `Subject: ${email.subject}`,
    `Date: ${email.receivedAt.toISOString()}`,
    '',
    body,
  ].join('\n');
}
