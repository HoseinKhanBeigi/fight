/**
 * OKX USDT-margined swap public books5 feed → absolute base-qty book.
 */

import WebSocket from "ws";
import { VenueDepthBook } from "./VenueDepthBook.js";

const WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const REST = "https://www.okx.com";

export class OkxDepthFeed {
  constructor({ instId, levels = 20, onStatus = null }) {
    this.instId = instId;
    this.levels = levels;
    this.onStatus = onStatus;
    this.book = new VenueDepthBook(levels);
    this.ctVal = 1; // contract size in base coin
    this.running = false;
    this.ws = null;
    this._gen = 0;
    this._pingTimer = null;
    this.status = "idle";
    this.supported = !!instId;
  }

  async start() {
    if (!this.instId) {
      this.status = "UNSUPPORTED";
      return;
    }
    this.running = true;
    await this._loadCtVal();
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

  async _loadCtVal() {
    try {
      const url = `${REST}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(this.instId)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const j = await res.json();
      const row = j?.data?.[0];
      const ct = Number(row?.ctVal);
      if (Number.isFinite(ct) && ct > 0) this.ctVal = ct;
      this._status(`OKX ctVal=${this.ctVal} for ${this.instId}`);
    } catch (e) {
      this._status(`OKX ctVal fetch failed: ${e.message}`);
    }
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
    this._status(`OKX connecting ${this.instId}`);
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this._gen) return;
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: [{ channel: "books5", instId: this.instId }],
        })
      );
      this._status(`OKX subscribed books5 ${this.instId}`);
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send("ping");
          } catch {
            /* ignore */
          }
        }
      }, 20000);
    });

    ws.on("message", (raw) => {
      if (!this.running || gen !== this._gen) return;
      const text = raw.toString();
      if (text === "pong") return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.event === "error") {
        this._status(`OKX error: ${msg.msg || JSON.stringify(msg)}`);
        return;
      }
      if (msg.arg?.channel !== "books5" || !msg.data?.[0]) return;
      const d = msg.data[0];
      // books5: bids/asks as [price, size(contracts), …]
      this.book.replace(d.bids || [], d.asks || [], Number(d.ts) || Date.now(), this.ctVal);
      if (this.book.ready) this._status("OKX live");
    });

    ws.on("close", () => {
      if (gen !== this._gen) return;
      this.book.ready = false;
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
      this._status("OKX reconnecting");
      if (this.running) {
        setTimeout(() => {
          if (this.running && gen === this._gen) this._connect();
        }, 1500);
      }
    });

    ws.on("error", (err) => {
      if (gen !== this._gen) return;
      this._status(`OKX ws error: ${err.message}`);
    });
  }
}
