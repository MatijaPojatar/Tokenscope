// Model pricing for the cache-economics ledger. Input list prices in USD
// per million tokens, cached from Anthropic's published pricing 2026-08
// (source: claude-api docs). Cache multipliers are stable API semantics:
// reads bill at 0.1x the input price, writes at 1.25x (5m TTL) or 2x (1h).
// Unknown models get a null price and the UI falls back to token-only.

const INPUT_PER_MTOK = [
  ['claude-fable-5', 10],
  ['claude-mythos-5', 10],
  ['claude-opus-5', 5],
  ['claude-opus-4', 5], // covers 4-5 through 4-8 (all $5 input)
  ['claude-sonnet-5', 3],
  ['claude-sonnet-4', 3],
  ['claude-haiku-4-5', 1],
];

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

// Longest matching prefix wins — transcript model ids may carry date
// suffixes (claude-haiku-4-5-20251001).
export function inputPricePerMTok(model) {
  if (!model) return null;
  let best = null;
  let bestLen = -1;
  for (const [prefix, price] of INPUT_PER_MTOK) {
    if (String(model).startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

export const usd = (tokens, perMTok, mult) => (tokens / 1e6) * perMTok * mult;
