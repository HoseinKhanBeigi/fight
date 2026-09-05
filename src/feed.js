/**
 * Binance USD-M Futures public market-data feed (no API key).
 *
 * Modes:
 * - partial20: @depth20@100ms top-of-book replace (works when REST/WS ID spaces differ)
 * - full: @depth@100ms + REST snapshot (when WS host matches fapi ID space)
 */

import WebSocket from "ws";

export class BinanceFuturesFeed {
  constructor({
    symbol,
    restBase,
    wsBase,
    wsFallbacks = [],
    depthLimit = 1000,
    bookMode = "partial20", // partial20 | full
    onDepth = null,
    onTrade = null,
    onResync = null,
    onStatus = null,
  }) {
    this.symbol = symbol.toLowerCase();
    this.symbolUpper = symbol.toUpperCase();
    this.restBase = restBase.replace(/\/$/, "");
    const bases = [wsBase, ...wsFallbacks]
      .filter(Boolean)
      .map((b) => b.replace(/\/$/, ""));
    this.wsBases = [...new Set(bases)];
    this.wsBaseIndex = 0;
    this.depthLimit = depthLimit;
    this.bookMode = bookMode;
    this.onDepth = onDepth;
    this.onTrade = onTrade;
    this.onResync = onResync;
    this.onStatus = onStatus;

    this.depthBuffer = [];
    this.bookReady = false;
    this.lastU = null;
    this.running = false;
    this.ws = null;
    this._resyncing = false;
    this._syncQueued = false;
    this._gotMessage = false;
    this._connGen = 0;
  }

  async start() {
    this.running = true;
    this._connectWs();
  }

  stop() {
    this.running = false;
    this._connGen += 1; // invalidate pending reconnect/sync callbacks
    this._closeWs();
  }

  _closeWs() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.removeAllListeners();
    // Closing while CONNECTING emits "error" — must have a listener or Node crashes
    ws.on("error", () => {});
    try {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  async fetchDepthSnapshot() {
    const url = `${this.restBase}/fapi/v1/depth?symbol=${this.symbolUpper}&limit=${this.depthLimit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Depth snapshot HTTP ${res.status}`);
    return res.json();
  }

  _status(msg) {
    if (this.onStatus) this.onStatus(msg);
  }

  _streamPath() {
    if (this.bookMode === "full") {
      return `${this.symbol}@aggTrade/${this.symbol}@depth@100ms`;
    }
    return `${this.symbol}@aggTrade/${this.symbol}@depth20@100ms`;
  }

  _connectWs() {
    if (!this.running) return;
    this._closeWs();

    const gen = ++this._connGen;
    const wsBase = this.wsBases[this.wsBaseIndex % this.wsBases.length];
    const url = `${wsBase}/stream?streams=${this._streamPath()}`;
    this._status(`Connecting ${url}`);
    this._gotMessage = false;
    this.bookReady = false;

    const ws = new WebSocket(url, {
      handshakeTimeout: 15000,
      headers: { "User-Agent": "binance-order-flow-monitor/1.0" },
    });
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this._connGen) return;
      this._status(`WebSocket connected (${wsBase}) mode=${this.bookMode}`);
      if (this.bookMode === "full") this.queueSync();
      else {
        // partial20 becomes ready on first depth frame
        if (this.onResync) this.onResync();
      }
    });

    ws.on("message", (raw) => {
      if (!this.running || gen !== this._connGen) return;
      this._gotMessage = true;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const data = msg.data ?? msg;
      if (data.e === "aggTrade") {
        if (this.onTrade) this.onTrade(data);
      } else if (data.e === "depthUpdate") {
        this._handleDepth(data);
      }
    });

    ws.on("close", () => {
      if (gen !== this._connGen) return;
      this.bookReady = false;
      if (!this._gotMessage && this.wsBases.length > 1) {
        this.wsBaseIndex = (this.wsBaseIndex + 1) % this.wsBases.length;
        this._status("WebSocket failed before data — trying fallback host");
      } else {
        this._status("WebSocket closed — reconnecting");
      }
      if (this.running) {
        setTimeout(() => {
          if (this.running && gen === this._connGen) this._connectWs();
        }, 1000);
      }
    });

    ws.on("error", (err) => {
      if (gen !== this._connGen) return;
      this._status(`WebSocket error: ${err.message}`);
    });
  }

  _handleDepth(data) {
    if (this.bookMode === "partial20") {
      // Each frame is a full top-20 replace
      const event = { ...data, _partial: true, _snapshot: !this.bookReady };
      if (!this.bookReady) {
        this.bookReady = true;
        this._status("Top-of-book live (depth20)");
      }
      this.lastU = Number(data.u);
      if (this.onDepth) this.onDepth(event);
      return;
    }

    if (!this.bookReady) {
      this.depthBuffer.push(data);
      if (this.depthBuffer.length > 5000) this.depthBuffer.shift();
      return;
    }
    if (!this._applyDepthEvent(data)) {
      this.bookReady = false;
      this.depthBuffer.push(data);
      this.queueSync();
      return;
    }
    if (this.onDepth) this.onDepth(data);
  }

  _applyDepthEvent(event) {
    if (event._snapshot) {
      this.lastU = Number(event.u);
      return true;
    }
    const u = Number(event.u);
    const U = Number(event.U);
    const pu = event.pu != null ? Number(event.pu) : null;

    if (this.lastU == null) {
      this.lastU = u;
      return true;
    }
    if (u <= this.lastU) return true;
    if (pu != null && pu !== this.lastU) {
      this._status(`Depth gap pu=${pu} lastU=${this.lastU}`);
      return false;
    }
    if (pu == null && U > this.lastU + 1) {
      this._status(`Depth gap U=${U} lastU=${this.lastU}`);
      return false;
    }
    this.lastU = u;
    return true;
  }

  queueSync() {
    if (this.bookMode !== "full") return;
    this._syncQueued = true;
    if (!this._resyncing) this._syncBook();
  }

  async _syncBook() {
    if (!this.running || this.bookMode !== "full") return;
    if (this._resyncing) {
      this._syncQueued = true;
      return;
    }
    this._resyncing = true;
    this._syncQueued = false;
    this.bookReady = false;

    try {
      for (let i = 0; i < 20 && this.depthBuffer.length < 2; i++) {
        await sleep(100);
        if (!this.running) return;
      }
      if (this.onResync) this.onResync();

      let snapshot = await this.fetchDepthSnapshot();
      let lastUpdateId = Number(snapshot.lastUpdateId);

      while (this.depthBuffer.length && Number(this.depthBuffer[0].u) <= lastUpdateId) {
        this.depthBuffer.shift();
      }

      let attempts = 0;
      while (attempts < 10) {
        if (!this.depthBuffer.length) {
          await sleep(150);
          attempts++;
          continue;
        }
        const first = this.depthBuffer[0];
        const U = Number(first.U);
        const u = Number(first.u);
        if (U <= lastUpdateId && lastUpdateId <= u) break;
        if (u < lastUpdateId) {
          this.depthBuffer.shift();
          continue;
        }
        // ID spaces may be incompatible (different WS hosts) — fall back
        if (Math.abs(u - lastUpdateId) / Math.max(lastUpdateId, 1) > 0.5) {
          throw new Error("DEPTH_ID_MISMATCH");
        }
        snapshot = await this.fetchDepthSnapshot();
        lastUpdateId = Number(snapshot.lastUpdateId);
        while (this.depthBuffer.length && Number(this.depthBuffer[0].u) <= lastUpdateId) {
          this.depthBuffer.shift();
        }
        attempts++;
      }

      if (!this.depthBuffer.length) {
        throw new Error("Unable to sync: empty depth buffer after snapshot");
      }

      const first = this.depthBuffer[0];
      const U = Number(first.U);
      const u = Number(first.u);
      if (!(U <= lastUpdateId && lastUpdateId <= u)) {
        throw new Error(
          `Unable to sync: snapshot ${lastUpdateId} not in first event [${U}, ${u}]`
        );
      }

      const snapEvent = {
        e: "depthUpdate",
        E: snapshot.E ?? Date.now(),
        T: snapshot.T ?? Date.now(),
        s: this.symbolUpper,
        U: lastUpdateId,
        u: lastUpdateId,
        pu: lastUpdateId - 1,
        b: snapshot.bids,
        a: snapshot.asks,
        _snapshot: true,
        lastUpdateId,
      };

      this.lastU = lastUpdateId;
      if (this.onDepth) this.onDepth(snapEvent);

      while (this.depthBuffer.length) {
        const event = this.depthBuffer.shift();
        if (Number(event.u) <= this.lastU) continue;
        if (!this._applyDepthEvent(event)) {
          throw new Error("Gap while draining depth buffer");
        }
        if (this.onDepth) this.onDepth(event);
      }

      this.bookReady = true;
      this._status(`Order book synchronized at u=${this.lastU}`);
    } catch (err) {
      if (String(err.message).includes("DEPTH_ID_MISMATCH") || String(err.message).includes("not in first event")) {
        this._status("Full-depth ID mismatch — falling back to depth20");
        this.bookMode = "partial20";
        this.depthBuffer = [];
        this._closeWs();
        this._connectWs();
      } else {
        this._status(`Sync failed: ${err.message} — retrying`);
        this.bookReady = false;
        this._syncQueued = true;
        setTimeout(() => {
          if (this.running) this.queueSync();
        }, 500);
      }
    } finally {
      this._resyncing = false;
      if (this._syncQueued && this.running && this.bookMode === "full") {
        setTimeout(() => this._syncBook(), 50);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
