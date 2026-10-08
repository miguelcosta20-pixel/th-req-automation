import Anthropic, { RateLimitError, InternalServerError } from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest, LlmResponse } from './client';

// LLM calls with large PDF attachments can take 30–45 s; 90 s gives headroom
// without letting a hung network call block run-all indefinitely.
const LLM_TIMEOUT_MS = 90_000;

// 3 total attempts: 1 initial + 2 retries. Backoff: 1 s → 2 s.
// Only 429 (rate limit) and 503 (service unavailable) are retried; other errors
// (validation, auth, timeout) are not transient and should surface immediately.
const MAX_ATTEMPTS   = 3;
const BASE_BACKOFF_MS = 1_000;

export class AnthropicClient implements LlmClient {
  private sdk: Anthropic;

  constructor(apiKey?: string) {
    this.sdk = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
      timeout: LLM_TIMEOUT_MS,
      // Disable SDK-level retries; we own the retry loop in complete() so each
      // attempt is logged and the strategy stays visible in one place.
      maxRetries: 0,
    });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(req);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
        const delayMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(
          `LLM attempt ${attempt}/${MAX_ATTEMPTS} failed (HTTP ${statusOf(err)}); retrying in ${delayMs} ms`,
        );
        await sleep(delayMs);
      }
    }
    throw lastErr; // unreachable, but satisfies TypeScript
  }

  private async attempt(req: LlmRequest): Promise<LlmResponse> {
    const start = Date.now();

    const response = await this.sdk.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      // ContentBlock[] cast: the SDK accepts document blocks but TypeScript types
      // may not include them depending on version; cast keeps compilation clean.
      messages: req.messages.map(m => ({
        role: m.role,
        content: m.content as Anthropic.ContentBlockParam[],
      })),
    });

    const latencyMs = Date.now() - start;

    const textBlock = response.content.find(b => b.type === 'text') as
      | Anthropic.TextBlock
      | undefined;

    return {
      text: textBlock?.text ?? '',
      model: response.model,
      usage: {
        tokensIn:  response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
      },
      latencyMs,
    };
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;                              // 429
  if (err instanceof InternalServerError && err.status === 503) return true;  // 503
  return false;
}

function statusOf(err: unknown): string {
  if (err instanceof RateLimitError || err instanceof InternalServerError) return String(err.status);
  return 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
