/**
 * Background watchlist aggression scanner.
 *
 * Watches ALL watchlist symbols except BTC/ETH via Binance Futures aggTrade.
 * Alerts when 1-minute aggressive buy OR sell notional exceeds threshold (default $500k).
 * Independent of the focused OrderFlowMonitor symbol.
 */

import WebSocket from "ws";
import { CONFIG } from "./config.js";
import { WATCHLIST } from "./watchlist.js";

const EXCLUDE = new Set(["BTCUSDT", "ETHUSDT"]);
const DEFAULT_THRESHOLD_USD = 500_000;
const WINDOW_SEC = 60;
const COOLDOWN_MS = 60_000;

function notional(qty, price) {
  const q = Number(qty);
  const p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0) return 0;
  return q * p;
}

export class WatchlistAggressionWatcher {
  constructor({
    thresholdUsd = DEFAULT_THRESHOLD_USD,
    windowSec = WINDOW_SEC,
    exclude = EXCLUDE,
    onAlert = null,
    onStatus = null,
  } = {}) {
    this.thresholdUsd = thresholdUsd;
    this.windowSec = windowSec;
    this.exclude = exclude instanceof Set ? exclude : new Set(exclude);
    this.onAlert = onAlert;
    this.onStatus = onStatus;

    this.symbols = WATCHLIST.filter((c) => !this.exclude.has(c.symbol.toUpperCase())).map(
      (c) => ({
        symbol: c.symbol.toUpperCase(),
        label: c.label,
        lower: c.symbol.toLowerCase(),
      })
    );

    /** @type {Map<string, {ts:number, side:'buy'|'sell', usd:number}[]>} */
    this.prints = new Map();
    /** @type {Map<string, number>} last alert ts by `${symbol}:${side}` */
    this.lastAlertAt = new Map();
    /** @type {Map<string, number>} last price */
    this.lastPrice = new Map();

    this.ws = null;
    this.running = false;
    this._gen = 0;
    this._tickTimer = null;
    this.status = "idle";
  }

  watchedSymbols() {
    return this.symbols.map((s) => s.symbol);
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const s of this.symbols) this.prints.set(s.symbol, []);
    this._connect();
    this._tickTimer = setInterval(() => this._scan(), 1000);
    this._status(
      `Watching ${this.symbols.length} symbols (ex BTC/ETH) · 1m agg > $${(
        this.thresholdUsd / 1000
      ).toFixed(0)}K`
    );
  }

  stop() {
    this.running = false;
    this._gen += 1;
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    this._close();
  }

  _status(msg) {
    this.status = msg;
    if (this.onStatus) this.onStatus(msg);
  }

  _close() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.removeAllListeners();
    ws.on("error", () => {});
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }

  _streamUrl() {
    const bases = [CONFIG.wsBase, ...(CONFIG.wsFallbacks || [])]
      .filter(Boolean)
      .map((b) => b.replace(/\/$/, ""));
    const unique = [...new Set(bases)];
    const wsBase = unique[this._gen % unique.length] || "wss://fstream.binancefuture.com";
    const streams = this.symbols.map((s) => `${s.lower}@aggTrade`).join("/");
    return `${wsBase}/stream?streams=${streams}`;
  }

  _connect() {
    if (!this.running || !this.symbols.length) return;
    this._close();
    const gen = ++this._gen;
    const url = this._streamUrl();
    this._status(`Connecting aggression watch…`);
    const ws = new WebSocket(url, {
      handshakeTimeout: 15000,
      headers: { "User-Agent": "binance-order-flow-monitor/aggression-watch" },
    });
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this._gen) return;
      this._status(
        `Background watch LIVE · ${this.symbols.length} coins · 1m > $${(this.thresholdUsd / 1000).toFixed(0)}K`
      );
    });

    ws.on("message", (raw) => {
      if (!this.running || gen !== this._gen) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const data = msg.data ?? msg;
      if (data.e !== "aggTrade") return;
      this._onTrade(data);
    });

    ws.on("close", () => {
      if (gen !== this._gen) return;
      this._status("Aggression watch reconnecting…");
      if (this.running) {
        setTimeout(() => {
          if (this.running && gen === this._gen) this._connect();
        }, 1500);
      }
    });

    ws.on("error", (err) => {
      if (gen !== this._gen) return;
      this._status(`Aggression watch error: ${err.message}`);
    });
  }

  _onTrade(data) {
    const symbol = String(data.s || "").toUpperCase();
    if (!this.prints.has(symbol)) return;
    const price = Number(data.p);
    const qty = Number(data.q);
    const usd = notional(qty, price);
    if (!(usd > 0)) return;
    const ts =
      (data.T || data.E || Date.now()) > 1e12
        ? (data.T || data.E) / 1000
        : Date.now() / 1000;
    // m=true → buyer is maker → aggressive sell
    const side = data.m ? "sell" : "buy";
    this.lastPrice.set(symbol, price);
    const arr = this.prints.get(symbol);
    arr.push({ ts, side, usd });
    // Keep a bit more than window
    const cutoff = ts - this.windowSec - 5;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
  }

  _sumWindow(symbol, now) {
    const arr = this.prints.get(symbol) || [];
    const lo = now - this.windowSec;
    let buy = 0;
    let sell = 0;
    for (const p of arr) {
      if (p.ts < lo) continue;
      if (p.side === "buy") buy += p.usd;
      else sell += p.usd;
    }
    return { buy, sell };
  }

  _scan() {
    if (!this.running) return;
    const now = Date.now() / 1000;
    const nowMs = Date.now();
    for (const meta of this.symbols) {
      const { buy, sell } = this._sumWindow(meta.symbol, now);
      this._maybeAlert(meta, "buy", buy, sell, nowMs);
      this._maybeAlert(meta, "sell", sell, buy, nowMs);
    }
  }

  _maybeAlert(meta, side, sideUsd, otherUsd, nowMs) {
    if (!(sideUsd >= this.thresholdUsd)) return;
    const key = `${meta.symbol}:${side}`;
    const last = this.lastAlertAt.get(key) || 0;
    if (nowMs - last < COOLDOWN_MS) return;
    this.lastAlertAt.set(key, nowMs);

    const alert = {
      id: `${meta.symbol}-${side}-${nowMs}`,
      ts: nowMs,
      symbol: meta.symbol,
      label: meta.label,
      side,
      windowSec: this.windowSec,
      thresholdUsd: this.thresholdUsd,
      aggressiveBuyUsd: side === "buy" ? sideUsd : otherUsd,
      aggressiveSellUsd: side === "sell" ? sideUsd : otherUsd,
      triggerUsd: sideUsd,
      price: this.lastPrice.get(meta.symbol) ?? null,
      message:
        side === "buy"
          ? `${meta.label} 1m aggressive BUY ${fmtUsdShort(sideUsd)} (>${fmtUsdShort(this.thresholdUsd)})`
          : `${meta.label} 1m aggressive SELL ${fmtUsdShort(sideUsd)} (>${fmtUsdShort(this.thresholdUsd)})`,
    };
    if (this.onAlert) this.onAlert(alert);
  }

  /** Snapshot for UI status strip */
  snapshot() {
    const now = Date.now() / 1000;
    const rows = this.symbols.map((meta) => {
      const { buy, sell } = this._sumWindow(meta.symbol, now);
      return {
        symbol: meta.symbol,
        label: meta.label,
        aggressiveBuyUsd: buy,
        aggressiveSellUsd: sell,
        hotBuy: buy >= this.thresholdUsd,
        hotSell: sell >= this.thresholdUsd,
        price: this.lastPrice.get(meta.symbol) ?? null,
      };
    });
    return {
      status: this.status,
      thresholdUsd: this.thresholdUsd,
      windowSec: this.windowSec,
      exclude: [...this.exclude],
      watching: this.symbols.map((s) => s.symbol),
      rows,
    };
  }
}

function fmtUsdShort(n) {
  const a = Math.abs(Number(n) || 0);
  if (a >= 1_000_000) return `$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `$${(a / 1_000).toFixed(0)}K`;
  return `$${a.toFixed(0)}`;
}
