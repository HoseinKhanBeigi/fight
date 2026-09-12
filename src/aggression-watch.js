/**
 * Background watchlist aggression scanner.
 *
 * Watches watchlist symbols via Binance Futures aggTrade — all of them by
 * default, or only `include` when that is given.
 * Alerts when aggressive buy OR sell notional over `windowSec` exceeds the
 * threshold (default $500k).
 * Independent of the focused OrderFlowMonitor symbol.
 */

import WebSocket from "ws";
import { CONFIG } from "./config.js";
import { WATCHLIST } from "./watchlist.js";

const EXCLUDE = new Set();
const DEFAULT_THRESHOLD_USD = 500_000;
const WINDOW_SEC = 60;

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
    include = null,
    cooldownMs = null,
    onAlert = null,
    onStatus = null,
  } = {}) {
    this.thresholdUsd = thresholdUsd;
    this.windowSec = windowSec;
    this.exclude = exclude instanceof Set ? exclude : new Set(exclude);
    this.include =
      include && include.length
        ? new Set([...include].map((s) => String(s).toUpperCase()))
        : null;
    // One burst stays inside the window for its full length, so a cooldown
    // shorter than the window would re-alert on the same trades.
    this.cooldownMs = cooldownMs ?? this.windowSec * 1000;
    this.onAlert = onAlert;
    this.onStatus = onStatus;

    this.symbols = WATCHLIST.filter((c) => {
      const sym = c.symbol.toUpperCase();
      if (this.include) return this.include.has(sym);
      return !this.exclude.has(sym);
    }).map((c) => ({
      symbol: c.symbol.toUpperCase(),
      label: c.label,
      lower: c.symbol.toLowerCase(),
    }));

    /** @type {Map<string, number[]>} recent trigger USD for percentile */
    this.triggerHist = new Map();
    /** @type {Map<string, {ts:number, side:'buy'|'sell', usd:number}[]>} */
    this.prints = new Map();
    /** @type {Map<string, number>} last alert ts by `${symbol}:${side}` */
    this.lastAlertAt = new Map();
    /** @type {Map<string, number>} last price */
    this.lastPrice = new Map();

    this.ws = null;
    this.running = false;
    this._gen = 0;
    this._failoverAttempt = 0;
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
      `Watching ${this.symbols.length} symbols · ${this.windowSec}s agg > $${(
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

  _wsBases() {
    return [
      ...new Set(
        [CONFIG.wsBase, ...(CONFIG.wsFallbacks || [])]
          .filter(Boolean)
          .map((b) => b.replace(/\/$/, ""))
      ),
    ];
  }

  _streamUrl(attempt = 0) {
    const bases = this._wsBases();
    // attempt 0 = primary (fstream.binancefuture.com). Do not key off _gen
    // after ++ or the first connect lands on a dead fallback that opens with no trades.
    const wsBase = bases[attempt % Math.max(bases.length, 1)] || "wss://fstream.binancefuture.com";
    const streams = this.symbols.map((s) => `${s.lower}@aggTrade`).join("/");
    return `${wsBase}/stream?streams=${streams}`;
  }

  _connect() {
    if (!this.running || !this.symbols.length) return;
    this._close();
    const gen = ++this._gen;
    const attempt = this._failoverAttempt || 0;
    const url = this._streamUrl(attempt);
    this._status(`Connecting aggression watch…`);
    const ws = new WebSocket(url, {
      handshakeTimeout: 15000,
      headers: { "User-Agent": "binance-order-flow-monitor/aggression-watch" },
    });
    this.ws = ws;
    let gotTrade = false;

    ws.on("open", () => {
      if (gen !== this._gen) return;
      this._status(
        `Background watch LIVE · ${this.symbols.length} coins · ${this.windowSec}s > $${(this.thresholdUsd / 1000).toFixed(0)}K`
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
      gotTrade = true;
      this._failoverAttempt = 0;
      this._onTrade(data);
    });

    ws.on("close", () => {
      if (gen !== this._gen) return;
      this._status("Aggression watch reconnecting…");
      if (this.running) {
        // Rotate endpoint if this socket never delivered trades (silent dead host).
        if (!gotTrade) {
          this._failoverAttempt = (attempt + 1) % Math.max(this._wsBases().length, 1);
        }
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

  _percentile(symbol, side, value) {
    const key = `${symbol}:${side}`;
    let arr = this.triggerHist.get(key);
    if (!arr) {
      arr = [];
      this.triggerHist.set(key, arr);
    }
    arr.push(value);
    while (arr.length > 200) arr.shift();
    if (arr.length < 8) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    let below = 0;
    for (const x of sorted) if (x < value) below += 1;
    return Math.round((below / (sorted.length - 1)) * 100);
  }

  _maybeAlert(meta, side, sideUsd, otherUsd, nowMs) {
    if (!(sideUsd >= this.thresholdUsd)) return;
    const key = `${meta.symbol}:${side}`;
    const last = this.lastAlertAt.get(key) || 0;
    if (nowMs - last < this.cooldownMs) return;
    this.lastAlertAt.set(key, nowMs);

    const buyUsd = side === "buy" ? sideUsd : otherUsd;
    const sellUsd = side === "sell" ? sideUsd : otherUsd;
    const tot = buyUsd + sellUsd;
    const imbalanceUsd = buyUsd - sellUsd;
    const imbalancePct = tot > 0 ? Math.round(((buyUsd - sellUsd) / tot) * 100) : 0;
    const imbLabel = imbalancePct > 0 ? `+${imbalancePct}%` : `${imbalancePct}%`;

    const percentile = this._percentile(meta.symbol, side, sideUsd);
    const alertType = side === "buy" ? "RAW_BUY_AGGRESSION" : "RAW_SELL_AGGRESSION";
    const alert = {
      id: `${meta.symbol}-${side}-${nowMs}`,
      ts: nowMs,
      symbol: meta.symbol,
      label: meta.label,
      side,
      windowSec: this.windowSec,
      thresholdUsd: this.thresholdUsd,
      aggressiveBuyUsd: buyUsd,
      aggressiveSellUsd: sellUsd,
      imbalanceUsd,
      imbalancePct,
      triggerUsd: sideUsd,
      price: this.lastPrice.get(meta.symbol) ?? null,
      layer: "raw",
      alertType,
      type: alertType,
      priority: "INFO",
      title: "AGG IMBALANCE",
      percentile,
      // Chat / notification: imbalance first, then both sides.
      message: `${meta.label} ${this.windowSec}s AGG IMB ${imbLabel} · BUY ${fmtUsdShort(buyUsd)} / SELL ${fmtUsdShort(sellUsd)}`,
    };
    if (this.onAlert) this.onAlert(alert);
  }

  /** Snapshot for UI status strip */
  snapshot() {
    const now = Date.now() / 1000;
    const rows = this.symbols.map((meta) => {
      const { buy, sell } = this._sumWindow(meta.symbol, now);
      const tot = buy + sell;
      const imbalancePct = tot > 0 ? Math.round(((buy - sell) / tot) * 100) : 0;
      return {
        symbol: meta.symbol,
        label: meta.label,
        aggressiveBuyUsd: buy,
        aggressiveSellUsd: sell,
        imbalanceUsd: buy - sell,
        imbalancePct,
        hotBuy: buy >= this.thresholdUsd,
        hotSell: sell >= this.thresholdUsd,
        price: this.lastPrice.get(meta.symbol) ?? null,
      };
    });
    return {
      status: this.status,
      thresholdUsd: this.thresholdUsd,
      windowSec: this.windowSec,
      cooldownMs: this.cooldownMs,
      include: this.include ? [...this.include] : null,
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
