import type { ModelPrice, PricingTable, Usage } from "./types.js";

/**
 * Fallback chars-per-token ratio for tool output. PRODUCT.md suggested 3.5; context-delta measurements on
 * real Claude Code sessions (Opus 5.x tokenizer) gave 2.4–3.1, median ≈ 2.6. See docs/decisions.md.
 */
export const CHARS_PER_TOKEN = 2.6;

export const charTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  };
}

export const totalTokens = (u: Usage): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** Longest pricing key that prefixes the model id, ignoring `[1m]`-style suffixes. */
export function lookupPrice(pricing: PricingTable, model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = model.replace(/\[.*\]$/, "");
  let best: string | undefined;
  for (const key of Object.keys(pricing.models)) {
    if ((id === key || id.startsWith(key + "-")) && (!best || key.length > best.length)) best = key;
  }
  return best ? pricing.models[best] : undefined;
}

export function priceUsage(u: Usage, p: ModelPrice): number {
  // Writes without a TTL breakdown are priced as 5m writes.
  const unsplit = Math.max(0, u.cacheWriteTokens - u.cacheWrite5mTokens - u.cacheWrite1hTokens);
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      (u.cacheWrite5mTokens + unsplit) * p.cacheWrite5m +
      u.cacheWrite1hTokens * p.cacheWrite1h) /
    1e6
  );
}

/** API-equivalent cost of everything billed in a session. Undefined when any model is unpriced. */
export function sessionCost(
  usageByModel: Record<string, Usage>,
  pricing: PricingTable,
): { estCostUsd?: number; costNote?: string } {
  let total = 0;
  const unknown: string[] = [];
  for (const [model, u] of Object.entries(usageByModel)) {
    const p = lookupPrice(pricing, model);
    if (p) total += priceUsage(u, p);
    else if (totalTokens(u) > 0) unknown.push(model);
  }
  if (unknown.length) return { costNote: `No price for ${unknown.sort().join(", ")}; showing tokens only.` };
  return { estCostUsd: total };
}
