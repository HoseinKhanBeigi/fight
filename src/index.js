#!/usr/bin/env node
/**
 * Real-time Binance USD-M Futures order-flow monitor (public data, no API key).
 *
 * Usage:
 *   npm start
 *   node src/index.js
 *   node src/index.js ethusdt
 *   node src/index.js btcusdt --full-depth
 */

import { CONFIG } from "./config.js";
import { OrderFlowMonitor } from "./monitor.js";
import { Dashboard } from "./dashboard.js";

const args = process.argv.slice(2);
const symbolArg = args.find((a) => !a.startsWith("--"));
const fullDepth = args.includes("--full-depth");

const config = {
  ...CONFIG,
  symbol: (symbolArg || CONFIG.symbol).toLowerCase(),
  bookMode: fullDepth ? "full" : CONFIG.bookMode,
};

const monitor = new OrderFlowMonitor(config);
const dashboard = new Dashboard(monitor, config.dashboardRefreshHz);

console.log(
  `Starting order-flow monitor for ${config.symbol.toUpperCase()} (mode=${config.bookMode})…`
);
await monitor.start();
dashboard.start();
