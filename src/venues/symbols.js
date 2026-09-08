/**
 * Map Binance-style symbols to OKX / Bybit / Hyperliquid identifiers.
 * Equity perps are Binance-primary; crypto perps map across venues.
 */

const CRYPTO_BASES = new Set([
  "BTC",
  "ETH",
  "SOL",
  "AVAX",
  "NEAR",
  "DOT",
  "LINK",
  "SUI",
]);

export function baseAsset(binanceSymbol = "") {
  return String(binanceSymbol)
    .toUpperCase()
    .replace(/USDT$/, "")
    .replace(/USDC$/, "")
    .replace(/[-_].*$/, "");
}

/**
 * @param {string} binanceSymbol e.g. BTCUSDT
 * @returns {{ binance: string, bybit: string|null, okx: string|null, hyperliquid: string|null, base: string }}
 */
export function venueSymbols(binanceSymbol) {
  const binance = String(binanceSymbol || "").toUpperCase();
  const base = baseAsset(binance);
  const isCrypto = CRYPTO_BASES.has(base);

  return {
    base,
    binance,
    // Bybit linear USDT perps use BTCUSDT naming for crypto; equity may exist but is optional.
    bybit: isCrypto ? binance : null,
    okx: isCrypto ? `${base}-USDT-SWAP` : null,
    hyperliquid: isCrypto ? base : null,
  };
}

export const VENUE_IDS = ["binance", "okx", "bybit", "hyperliquid"];

export const VENUE_LABELS = {
  binance: "Binance",
  okx: "OKX",
  bybit: "Bybit",
  hyperliquid: "Hyperliquid",
};
