/**
 * Watchlist mirrored from oderFlow (`src/live/watchlist.ts`).
 * Crypto + Binance USD-M equity / TradFi perpetuals.
 */

export const CRYPTO_WATCHLIST = [
  { symbol: "SOLUSDT", label: "SOL" },
  { symbol: "AVAXUSDT", label: "AVAX" },
  { symbol: "NEARUSDT", label: "NEAR" },
  { symbol: "SUIUSDT", label: "SUI" },
  { symbol: "XRPUSDT", label: "XRP" },
  { symbol: "FARTCOINUSDT", label: "FARTCOIN" },
  { symbol: "EGLDUSDT", label: "EGLD" },
];

/** Binance TradFi / equity / commodity perps (same futures WS). */
export const EQUITY_WATCHLIST = [
  { symbol: "CLUSDT", label: "CL" },
  { symbol: "AAPLUSDT", label: "AAPL" },
  { symbol: "AMZNUSDT", label: "AMZN" },
  { symbol: "METAUSDT", label: "META" },
  { symbol: "MSFTUSDT", label: "MSFT" },
  { symbol: "GOOGLUSDT", label: "GOOGL" },
  { symbol: "TSLAUSDT", label: "TSLA" },
  { symbol: "AMDUSDT", label: "AMD" },
  { symbol: "NVDAUSDT", label: "NVDA" },
];

export const WATCHLIST = [...CRYPTO_WATCHLIST, ...EQUITY_WATCHLIST];

export function watchlistSymbols() {
  return WATCHLIST.map((c) => c.symbol);
}
