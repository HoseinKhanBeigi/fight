/** Local order book with per-level liquidity analytics state. */

export class LevelState {
  constructor(price, quantity, side, now = Date.now() / 1000) {
    this.price = price;
    this.quantity = quantity;
    this.previousQuantity = quantity;
    this.side = side; // bid | ask
    this.lastUpdate = now;
    this.lastTradeVolume = 0;
    this.estimatedCancelledVolume = 0;
    this.estimatedRefillVolume = 0;
    this.estimatedStackVolume = 0;
    this.takerBuyVolume = 0;
    this.takerSellVolume = 0;
    this.confirmedTradeVolume = 0;
    this.createdAt = now;
  }
}

export class LiquidityEvent {
  constructor({
    timestamp,
    price,
    side,
    eventType,
    volume,
    previousSize,
    currentSize,
    matchedTradeVolume,
  }) {
    this.timestamp = timestamp;
    this.price = price;
    this.side = side;
    this.eventType = eventType;
    this.volume = volume;
    this.previousSize = previousSize;
    this.currentSize = currentSize;
    this.matchedTradeVolume = matchedTradeVolume;
  }
}

export class LocalOrderBook {
  constructor(nearLevels = 50) {
    /** @type {Map<number, LevelState>} */
    this.bids = new Map(); // price -> LevelState
    /** @type {Map<number, LevelState>} */
    this.asks = new Map();
    this.sortedBids = []; // descending
    this.sortedAsks = []; // ascending
    this.nearLevels = nearLevels;
    this.lastUpdateId = null;
    this.lastEventTime = 0;
    this.tickSize = null;
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
    this.sortedBids = [];
    this.sortedAsks = [];
    this.lastUpdateId = null;
  }

  _rebuildSorted(side) {
    if (side === "bid") {
      this.sortedBids = [...this.bids.keys()].sort((a, b) => b - a);
    } else {
      this.sortedAsks = [...this.asks.keys()].sort((a, b) => a - b);
    }
  }

  bestBid() {
    if (!this.sortedBids.length) return null;
    return this.bids.get(this.sortedBids[0]) ?? null;
  }

  bestAsk() {
    if (!this.sortedAsks.length) return null;
    return this.asks.get(this.sortedAsks[0]) ?? null;
  }

  midPrice() {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (!bb || !ba) return null;
    return (bb.price + ba.price) / 2;
  }

  spread() {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (!bb || !ba) return null;
    return ba.price - bb.price;
  }

  inferTickSize() {
    const prices = [
      ...this.sortedBids.slice(0, 20),
      ...this.sortedBids.slice(-20),
      ...this.sortedAsks.slice(0, 20),
      ...this.sortedAsks.slice(-20),
    ]
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .sort((a, b) => a - b);

    if (prices.length < 2) return this.tickSize;
    let minDiff = Infinity;
    for (let i = 0; i < prices.length - 1; i++) {
      const d = +(prices[i + 1] - prices[i]).toFixed(10);
      if (d > 0 && d < minDiff) minDiff = d;
    }
    if (minDiff < Infinity) this.tickSize = minDiff;
    return this.tickSize;
  }

  applySnapshot(bids, asks, updateId, ts) {
    this.clear();
    const now = ts > 1e12 ? ts / 1000 : ts || Date.now() / 1000;

    for (const [priceS, qtyS] of bids) {
      const price = Number(priceS);
      const qty = Number(qtyS);
      if (qty <= 0) continue;
      this.bids.set(price, new LevelState(price, qty, "bid", now));
    }
    for (const [priceS, qtyS] of asks) {
      const price = Number(priceS);
      const qty = Number(qtyS);
      if (qty <= 0) continue;
      this.asks.set(price, new LevelState(price, qty, "ask", now));
    }
    this._rebuildSorted("bid");
    this._rebuildSorted("ask");
    this.lastUpdateId = updateId;
    this.lastEventTime = now;
    this.inferTickSize();
  }

  getSideBook(side) {
    return side === "bid" ? this.bids : this.asks;
  }

  nearLevelsList(side, n = this.nearLevels) {
    const prices = side === "bid" ? this.sortedBids : this.sortedAsks;
    const book = this.getSideBook(side);
    const out = [];
    for (let i = 0; i < Math.min(n, prices.length); i++) {
      const lvl = book.get(prices[i]);
      if (lvl) out.push(lvl);
    }
    return out;
  }

  totalNearLiquidity(side, n = this.nearLevels) {
    return this.nearLevelsList(side, n).reduce((s, l) => s + l.quantity, 0);
  }

  levelSizes(side, n = this.nearLevels) {
    return this.nearLevelsList(side, n).map((l) => l.quantity);
  }

  /**
   * Set absolute quantity. Returns { previous, current, level }.
   * level is null if removed.
   * Pass rebuild=false when applying many updates, then call rebuildSorted().
   */
  setLevelQty(side, price, qty, now, rebuild = true) {
    const book = this.getSideBook(side);
    const prev = book.has(price) ? book.get(price).quantity : 0;
    let structureChanged = false;

    if (qty <= 0) {
      if (book.has(price)) {
        book.delete(price);
        structureChanged = true;
      }
      if (rebuild && structureChanged) this._rebuildSorted(side);
      return { previous: prev, current: 0, level: null };
    }

    let lvl = book.get(price);
    if (!lvl) {
      lvl = new LevelState(price, qty, side, now);
      lvl.previousQuantity = prev;
      book.set(price, lvl);
      structureChanged = true;
    } else {
      lvl.previousQuantity = prev;
      lvl.quantity = qty;
      lvl.lastUpdate = now;
    }
    if (rebuild && structureChanged) this._rebuildSorted(side);
    return { previous: prev, current: qty, level: lvl };
  }

  rebuildSorted(side = null) {
    if (side === "bid" || side == null) this._rebuildSorted("bid");
    if (side === "ask" || side == null) this._rebuildSorted("ask");
  }
}
