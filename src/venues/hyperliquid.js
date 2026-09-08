/**
 * Hyperliquid public l2Book feed → absolute base-qty book.
 */

import WebSocket from "ws";
import { VenueDepthBook } from "./VenueDepthBook.js";

const WS_URL = "wss://api.hyperliquid.xyz/ws";

export class HyperliquidDepthFeed {
  constructor({ coin, levels = 20, onStatus = null }) {
    this.coin = coin; // BTC
    this.levels = levels;
    this.onStatus = onStatus;
    this.book = new VenueDepthBook(levels);
    this.running = false;
    this.ws = null;
    this._gen = 0;
    this._pingTimer = null;
    this.status = "idle";
    this.supported = !!coin;
  }

  async start() {
    if (!this.coin) {
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
    this._status(`HL connecting ${this.coin}`);
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this._gen) return;
      ws.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "l2Book", coin: this.coin, fast: true },
        })
      );
      this._status(`HL subscribed l2Book ${this.coin}`);
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(JSON.stringify({ method: "ping" }));
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
      if (msg.channel === "pong" || msg.channel === "subscriptionResponse") return;
      if (msg.channel !== "l2Book" || !msg.data) return;

      const d = msg.data;
      // levels: [bids[], asks[]] each level { px, sz, n }
      const bidLevels = d.levels?.[0] || [];
      const askLevels = d.levels?.[1] || [];
      const bids = bidLevels.map((l) => [l.px ?? l.price, l.sz ?? l.size]);
      const asks = askLevels.map((l) => [l.px ?? l.price, l.sz ?? l.size]);
      this.book.replace(bids, asks, Number(d.time) || Date.now(), 1);
      if (this.book.ready) this._status("HL live");
    });

    ws.on("close", () => {
      if (gen !== this._gen) return;
      this.book.ready = false;
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
      this._status("HL reconnecting");
      if (this.running) {
        setTimeout(() => {
          if (this.running && gen === this._gen) this._connect();
        }, 1500);
      }
    });

    ws.on("error", (err) => {
      if (gen !== this._gen) return;
      this._status(`HL ws error: ${err.message}`);
    });
  }
}
