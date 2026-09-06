/** Configurable parameters for the order-flow monitor. */
export const CONFIG = {
  symbol: "btcusdt",
  windows: [1, 5, 15, 60, 300, 900, 1800, 2700],
  bookDepthLimit: 1000,
  nearBookLevels: 20,
  footprintBidLevels: 30,
  footprintAskLevels: 30,
  footprintDepthLimit: 100, // REST ladder for deeper footprint rows
  footprintDepthRefreshMs: 2000,
  wallPercentile: 95,
  wallMultiplier: 3.0,
  bookMode: "partial20", // partial20 (reliable) | full (REST+diff when ID spaces match)
  minimumWallLifetimeMs: 500,
  minimumCancelVolume: 0.05,
  minimumStackVolume: 0.05,
  cancelSurgeRatio: 0.5,
  minimumRefillRatio: 0.3,
  sweepExecutionRatio: 0.7,
  pullCancelRatio: 0.7,
  sweepDepletionRatio: 0.7,
  priceResponseTicks: 2,
  signalPersistenceMs: 1000,
  tradeBookMatchToleranceMs: 250,
  epsilon: 1e-9,
  dashboardRefreshHz: 4,
  footprintIntervalSec: 5,
  footprintColumns: 48,
  footprintPricePrecision: 1,
  restBase: "https://fapi.binance.com",
  // Primary futures WS; some networks block fstream.binance.com TLS.
  wsBase: "wss://fstream.binancefuture.com",
  wsFallbacks: [
    "wss://fstream.binancefuture.com",
    "wss://fstream.binance.com",
  ],
};
