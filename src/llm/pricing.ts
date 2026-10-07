// Estimated CHF cost per 1 M tokens. Updated manually when pricing changes.
// FX rate baked in: $1 ≈ CHF 0.88 (from master_data.json).
const PRICING_CHF: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5':          { input: 2.64,  output: 13.2  },
  'claude-opus-5-5':            { input: 13.2,  output: 66.0  },
  'claude-haiku-4-5-20251001':  { input: 0.22,  output: 1.1   },
  'claude-fable-5-1':           { input: 2.64,  output: 13.2  },
  // fallback for unknown models — conservative estimate
  default:                       { input: 3.52,  output: 17.6  },
};

export function computeCostChf(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING_CHF[model] ?? PRICING_CHF.default;
  const cost = (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000; // 4 decimal places is enough for a single call
}
