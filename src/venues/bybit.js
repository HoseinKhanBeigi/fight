/**
 * Bybit linear USDT perpetual public orderbook → absolute base-qty book.
 */

import WebSocket from "ws";
import { VenueDepthBook } from "./VenueDepthBook.js";

const WS_URL = "wss://stream.bybit.com/v5/public/linear";

export class BybitDepthFeed {
  constructor({ symbol, levels = 20, onStatus = null }) {
    this.symbol = symbol; // BTCUSDT
    this.levels = levels;
    this.onStatus = onStatus;
    this.book = new VenueDepthBook(levels);
    this.running = false;
    this.ws = null;
    this._gen = 0;
    this._pingTimer = null;
    this.status = "idle";
    this.supported = !!symbol;
    /** @type {Map<string, number>} */
    this._bids = new Map();
    /** @type {Map<string, number>} */
    this._asks = new Map();
  }

  async start() {
    if (!this.symbol) {
      this.status = "UNSUPPORTED";
      return;
    }
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    this._gen += 1;
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this._close();
    this._bids.clear();
    this._asks.clear();
    this.book.clear();
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

  _connect() {
    if (!this.running) return;
    this._close();
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    const gen = ++this._gen;
    this._status(`Bybit connecting ${this.symbol}`);
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this._gen) return;
      // 50 levels is enough for near-touch USD sum
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: [`orderbook.50.${this.symbol}`],
        })
      );
      this._status(`Bybit subscribed orderbook.50.${this.symbol}`);
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(JSON.stringify({ op: "ping" }));
          } catch {
            /* ignore */
          }
        }
      }, 20000);
    });

    ws.on("message", (raw) => {
      if (!this.running || gen !== this._gen) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.op === "pong" || msg.ret_msg === "pong" || msg.success === true) return;
      if (!msg.topic?.startsWith("orderbook.") || !msg.data) return;

      const d = msg.data;
      const type = msg.type; // snapshot | delta
      if (type === "snapshot") {
        this._bids.clear();
        this._asks.clear();
        for (const [p, q] of d.b || []) {
          const qty = Number(q);
          if (qty > 0) this._bids.set(String(p), qty);
        }
        for (const [p, q] of d.a || []) {
          const qty = Number(q);
          if (qty > 0) this._asks.set(String(p), qty);
        }
      } else if (type === "delta") {
        for (const [p, q] of d.b || []) {
          const qty = Number(q);
          if (qty <= 0) this._bids.delete(String(p));
          else this._bids.set(String(p), qty);
        }
        for (const [p, q] of d.a || []) {
          const qty = Number(q);
          if (qty <= 0) this._asks.delete(String(p));
          else this._asks.set(String(p), qty);
        }
      } else {
        return;
      }

      const bids = [...this._bids.entries()].map(([p, q]) => [p, q]);
      const asks = [...this._asks.entries()].map(([p, q]) => [p, q]);
      this.book.replace(bids, asks, Number(d.ts) || Date.now(), 1);
      if (this.book.ready) this._status("Bybit live");
    });

    ws.on("close", () => {
      if (gen !== this._gen) return;
      this.book.ready = false;
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
      this._status("Bybit reconnecting");
      if (this.running) {
        setTimeout(() => {
          if (this.running && gen === this._gen) this._connect();
        }, 1500);
      }
    });

    ws.on("error", (err) => {
      if (gen !== this._gen) return;
      this._status(`Bybit ws error: ${err.message}`);
    });
  }
}
