// Converts an amount in the given currency to CHF using FX rates from master data.
// Rounding rule (D19): apply rate to the full total once, then Math.round to 2 dp
// (half-up). Never per-line — per-line rounding accumulates drift over many items.
export function convertToChf(
  amount: number,
  currency: string,
  fxRates: Record<string, number>,
): number {
  const rate = fxRates[currency];
  if (rate === undefined) {
    throw new Error(
      `Unsupported currency: ${currency}. Known: ${Object.keys(fxRates).join(', ')}`,
    );
  }
  return Math.round(amount * rate * 100) / 100;
}
