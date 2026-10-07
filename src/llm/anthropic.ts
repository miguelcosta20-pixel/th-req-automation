import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest, LlmResponse } from './client';

export class AnthropicClient implements LlmClient {
  private sdk: Anthropic;

  constructor(apiKey?: string) {
    this.sdk = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
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
