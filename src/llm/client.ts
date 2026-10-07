import type { DocumentBlock } from '../types';

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextBlock | DocumentBlock;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
