/** Aggressive trade tracking and rolling-window metrics. */

export class TradePrint {
  constructor({ timestamp, price, quantity, isBuyerMaker, tradeId }) {
    this.timestamp = timestamp; // seconds
    this.price = price;
    this.quantity = quantity;
    this.isBuyerMaker = isBuyerMaker;
    this.tradeId = tradeId;
  }

  get isAggressiveBuy() {
    return !this.isBuyerMaker;
  }

  get isAggressiveSell() {
    return this.isBuyerMaker;
  }

  get side() {
    return this.isAggressiveBuy ? "buy" : "sell";
  }
}

export class WindowStats {
  constructor() {
    this.aggressiveBuyVolume = 0;
    this.aggressiveSellVolume = 0;
  }

  get netDelta() {
    return this.aggressiveBuyVolume - this.aggressiveSellVolume;
  }

  get totalVolume() {
    return this.aggressiveBuyVolume + this.aggressiveSellVolume;
  }

  get buyRatio() {
    const t = this.totalVolume;
    return t > 0 ? this.aggressiveBuyVolume / t : 0;
  }

  get sellRatio() {
    const t = this.totalVolume;
    return t > 0 ? this.aggressiveSellVolume / t : 0;
  }
}

export class AggressiveFlowTracker {
  constructor(windows, matchToleranceMs = 250) {
    this.windows = [...windows];
    this.maxWindow = Math.max(...this.windows, 60);
    this.matchTolerance = matchToleranceMs / 1000;
    /** @type {TradePrint[]} */
    this.trades = [];
    /** @type {Set<number|string>} */
    this.seenIds = new Set();
    /** @type {Map<number, {ts:number, qty:number}[]>} */
    this.buysByPrice = new Map();
    /** @type {Map<number, {ts:number, qty:number}[]>} */
    this.sellsByPrice = new Map();
    this.lastPrice = null;
    /** @type {{ts:number, price:number}[]} */
    this.priceHistory = [];
  }

  clear() {
    this.trades = [];
    this.seenIds.clear();
    this.buysByPrice.clear();
    this.sellsByPrice.clear();
    this.lastPrice = null;
    this.priceHistory = [];
  }

  /**
   * @returns {boolean} true if the trade was accepted (not a duplicate)
   */
  onTrade(trade) {
    const id = trade.tradeId;
    if (id != null && id !== 0) {
      if (this.seenIds.has(id)) return false;
      this.seenIds.add(id);
    }

    this.trades.push(trade);
    this.lastPrice = trade.price;
    this.priceHistory.push({ ts: trade.timestamp, price: trade.price });
    if (this.priceHistory.length > 5000) this.priceHistory.shift();

    const map = trade.isAggressiveBuy ? this.buysByPrice : this.sellsByPrice;
    if (!map.has(trade.price)) map.set(trade.price, []);
    map.get(trade.price).push({ ts: trade.timestamp, qty: trade.quantity });
    this._prune(trade.timestamp);
    return true;
  }

  _prune(now) {
    const cutoff = now - this.maxWindow - 1;
    // Trades may be unsorted after backfill — drop any stale prints, not only the head
    if (this.trades.length) {
      const kept = [];
      for (const t of this.trades) {
        if (t.timestamp >= cutoff) kept.push(t);
        else if (t.tradeId != null && t.tradeId !== 0) this.seenIds.delete(t.tradeId);
      }
      this.trades = kept;
    }

    // Bound seen-id set if prune left it large (ids from dropped trades already deleted above)
    if (this.seenIds.size > this.trades.length * 2 + 1000) {
      this.seenIds.clear();
      for (const t of this.trades) {
        if (t.tradeId != null && t.tradeId !== 0) this.seenIds.add(t.tradeId);
      }
    }

    const matchCutoff = now - Math.max(this.matchTolerance * 4, 2);
    for (const map of [this.buysByPrice, this.sellsByPrice]) {
      for (const [price, arr] of map) {
        while (arr.length && arr[0].ts < matchCutoff) arr.shift();
        if (!arr.length) map.delete(price);
      }
    }

    while (this.priceHistory.length && this.priceHistory[0].ts < cutoff) {
      this.priceHistory.shift();
    }
  }

  windowStats(now = null) {
    if (now == null) {
      now = this.trades.length ? this.trades[this.trades.length - 1].timestamp : 0;
    }
    this._prune(now);

    /** @type {Record<number, WindowStats>} */
    const result = {};
    for (const w of this.windows) result[w] = new WindowStats();

    for (const trade of this.trades) {
      const age = now - trade.timestamp;
      if (age < 0 || age > this.maxWindow) continue;
      for (const w of this.windows) {
        if (age <= w) {
          if (trade.isAggressiveBuy) result[w].aggressiveBuyVolume += trade.quantity;
          else result[w].aggressiveSellVolume += trade.quantity;
        }
      }
    }
    return result;
  }

  /**
   * Match and consume trade volume so it isn't double-counted.
   * side='ask' consumes aggressive buys; side='bid' consumes aggressive sells.
   */
  consumeMatchedVolume(price, side, eventTs, maxQty) {
    const map = side === "ask" ? this.buysByPrice : this.sellsByPrice;
    const arr = map.get(price);
    if (!arr || maxQty <= 0) return 0;

    const lo = eventTs - this.matchTolerance;
    const hi = eventTs + this.matchTolerance;
    let remaining = maxQty;
    let consumed = 0;
    const next = [];

    for (const item of arr) {
      if (remaining > 0 && item.ts >= lo && item.ts <= hi) {
        const take = Math.min(item.qty, remaining);
        consumed += take;
        remaining -= take;
        const leftover = item.qty - take;
        if (leftover > 1e-12) next.push({ ts: item.ts, qty: leftover });
      } else {
        next.push(item);
      }
    }

    if (next.length) map.set(price, next);
    else map.delete(price);
    return consumed;
  }

  priceChangeTicks(lookbackS, tickSize, now) {
    if (!this.priceHistory.length || !tickSize || tickSize <= 0) return 0;
    const current = this.priceHistory[this.priceHistory.length - 1].price;
    const target = now - lookbackS;
    let pastPrice = this.priceHistory[0].price;
    for (const { ts, price } of this.priceHistory) {
      if (ts >= target) {
        pastPrice = price;
        break;
      }
      pastPrice = price;
    }
    return (current - pastPrice) / tickSize;
  }
}
