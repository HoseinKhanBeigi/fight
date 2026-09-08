/**
 * Lightweight absolute L2 book for multi-venue depth (base-asset qty).
 * Used only for USD liquidity aggregation — not battle scoring.
 */

export class VenueDepthBook {
  constructor(levels = 20) {
    this.levels = levels;
    /** @type {Array<{price:number, qty:number}>} */
    this.bids = [];
    /** @type {Array<{price:number, qty:number}>} */
    this.asks = [];
    this.lastUpdate = 0;
    this.ready = false;
  }

  clear() {
    this.bids = [];
    this.asks = [];
    this.ready = false;
    this.lastUpdate = 0;
  }

  /**
   * Replace book with absolute levels.
   * @param {Array<[number|string, number|string]|{price:any,qty?:any,sz?:any,px?:any}>} bids
   * @param {Array<[number|string, number|string]|{price:any,qty?:any,sz?:any,px?:any}>} asks
   * @param {number} [tsMs]
   * @param {number} [sizeMult=1] multiply raw size → base asset (e.g. OKX ctVal)
   */
  replace(bids, asks, tsMs = Date.now(), sizeMult = 1) {
    const mult = Number.isFinite(sizeMult) && sizeMult > 0 ? sizeMult : 1;
    this.bids = normalizeSide(bids, mult)
      .filter((l) => l.qty > 0 && l.price > 0)
      .sort((a, b) => b.price - a.price)
      .slice(0, this.levels);
    this.asks = normalizeSide(asks, mult)
      .filter((l) => l.qty > 0 && l.price > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, this.levels);
    this.lastUpdate = tsMs > 1e12 ? tsMs / 1000 : tsMs > 1e9 ? tsMs : Date.now() / 1000;
    this.ready = this.bids.length > 0 && this.asks.length > 0;
  }

  /** Import from LocalOrderBook near levels (Binance primary). */
  fromLocalBook(localBook, n = this.levels) {
    if (!localBook) {
      this.clear();
      return;
    }
    const bids = (localBook.nearLevelsList?.("bid", n) || []).map((l) => ({
      price: l.price,
      qty: l.quantity,
    }));
    const asks = (localBook.nearLevelsList?.("ask", n) || []).map((l) => ({
      price: l.price,
      qty: l.quantity,
    }));
    this.bids = bids;
    this.asks = asks;
    this.lastUpdate = localBook.lastEventTime || Date.now() / 1000;
    this.ready = this.bids.length > 0 && this.asks.length > 0;
  }

  bestBid() {
    return this.bids[0] || null;
  }

  bestAsk() {
    return this.asks[0] || null;
  }

  mid() {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (!bb || !ba) return null;
    return (bb.price + ba.price) / 2;
  }

  /** Base-asset qty near touch. */
  nearBase(side, n = this.levels) {
    const arr = side === "bid" ? this.bids : this.asks;
    let s = 0;
    for (let i = 0; i < Math.min(n, arr.length); i++) s += arr[i].qty;
    return s;
  }

  /** USD notional near touch (price × base qty). */
  nearUsd(side, n = this.levels) {
    const arr = side === "bid" ? this.bids : this.asks;
    let s = 0;
    for (let i = 0; i < Math.min(n, arr.length); i++) {
      s += arr[i].price * arr[i].qty;
    }
    return s;
  }

  stale(nowSec = Date.now() / 1000, maxAgeSec = 3) {
    if (!this.ready || !this.lastUpdate) return true;
    return nowSec - this.lastUpdate > maxAgeSec;
  }
}

function normalizeSide(levels, sizeMult) {
  if (!Array.isArray(levels)) return [];
  return levels.map((row) => {
    if (Array.isArray(row)) {
      return { price: Number(row[0]), qty: Number(row[1]) * sizeMult };
    }
    const price = Number(row.price ?? row.px ?? row[0]);
    const qty = Number(row.qty ?? row.sz ?? row.size ?? row[1]) * sizeMult;
    return { price, qty };
  });
}
