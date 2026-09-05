/**
 * Footprint chart aggregator.
 * Buckets aggressive trades (and estimated cancel/refill) by time × price.
 * Does not change underlying trade/cancel formulas — only bins existing outputs.
 */

function emptyCell() {
  return {
    buy: 0, // aggressive buy (hits ask)
    sell: 0, // aggressive sell (hits bid)
    cancelBid: 0,
    cancelAsk: 0,
    refillBid: 0,
    refillAsk: 0,
    execBid: 0,
    execAsk: 0,
  };
}

export class FootprintAggregator {
  /**
   * @param {{ intervalSec?: number, maxColumns?: number, pricePrecision?: number }} opts
   */
  constructor(opts = {}) {
    this.intervalSec = opts.intervalSec ?? 5;
    this.maxColumns = opts.maxColumns ?? 48;
    this.pricePrecision = opts.pricePrecision ?? 1;
    /** @type {Map<number, Map<number, ReturnType<typeof emptyCell>>>} */
    this.columns = new Map(); // bucketStart -> price -> cell
    this.lastPrice = null;
  }

  setInterval(sec) {
    const n = Number(sec);
    if (!n || n === this.intervalSec) return;
    this.intervalSec = n;
    // Keep a usable history length per timeframe
    if (n >= 300) this.maxColumns = 24; // ~2h of 5m bars
    else if (n >= 60) this.maxColumns = 36;
    else this.maxColumns = 48;
    this.columns.clear();
  }

  _bucket(ts) {
    return Math.floor(ts / this.intervalSec) * this.intervalSec;
  }

  _priceKey(price) {
    const f = 10 ** this.pricePrecision;
    return Math.round(price * f) / f;
  }

  _cell(bucket, price) {
    if (!this.columns.has(bucket)) this.columns.set(bucket, new Map());
    const col = this.columns.get(bucket);
    const pk = this._priceKey(price);
    if (!col.has(pk)) col.set(pk, emptyCell());
    return col.get(pk);
  }

  _prune(now) {
    const minBucket = this._bucket(now) - this.maxColumns * this.intervalSec;
    for (const b of [...this.columns.keys()]) {
      if (b < minBucket) this.columns.delete(b);
    }
  }

  onTrade(trade) {
    const bucket = this._bucket(trade.timestamp);
    const cell = this._cell(bucket, trade.price);
    if (trade.isAggressiveBuy) cell.buy += trade.quantity;
    else cell.sell += trade.quantity;
    this.lastPrice = trade.price;
    this._prune(trade.timestamp);
  }

  /**
   * Ingest liquidity events from LiquidityEngine (estimates).
   * @param {import('./book.js').LiquidityEvent[]} events
   */
  onLiquidityEvents(events) {
    if (!events?.length) return;
    for (const ev of events) {
      const bucket = this._bucket(ev.timestamp);
      const cell = this._cell(bucket, ev.price);
      const vol = ev.volume || 0;
      if (ev.eventType === "EXECUTION") {
        if (ev.side === "ask") cell.execAsk += ev.matchedTradeVolume || vol;
        else cell.execBid += ev.matchedTradeVolume || vol;
      } else if (ev.eventType === "CANCELLATION" || ev.eventType === "PULLING") {
        if (ev.side === "ask") cell.cancelAsk += vol;
        else cell.cancelBid += vol;
      } else if (ev.eventType === "REFILL" || ev.eventType === "STACKING") {
        if (ev.side === "ask") cell.refillAsk += vol;
        else cell.refillBid += vol;
      }
      this._prune(ev.timestamp);
    }
  }

  /**
   * Build renderable footprint matrix.
   * @param {number} now
   * @param {{
   *   bookBids?: Array<{price:number, quantity:number}>,
   *   bookAsks?: Array<{price:number, quantity:number}>,
   *   bidLevels?: number,
   *   askLevels?: number,
   * }} [book]
   */
  snapshot(now = Date.now() / 1000, book = {}) {
    this._prune(now);
    const bucketStarts = [...this.columns.keys()].sort((a, b) => a - b);
    const priceSet = new Set();
    let maxVol = 0;

    /** @type {Record<number, {side:string, quantity:number}>} */
    const resting = {};
    const bidLevels = book.bidLevels ?? 30;
    const askLevels = book.askLevels ?? 30;

    const asks = (book.bookAsks || []).slice(0, askLevels);
    const bids = (book.bookBids || []).slice(0, bidLevels);
    for (const lvl of asks) {
      const pk = this._priceKey(lvl.price);
      priceSet.add(pk);
      resting[pk] = { side: "ask", quantity: lvl.quantity };
    }
    for (const lvl of bids) {
      const pk = this._priceKey(lvl.price);
      priceSet.add(pk);
      resting[pk] = { side: "bid", quantity: lvl.quantity };
    }

    const columns = bucketStarts.map((t) => {
      const map = this.columns.get(t);
      const cells = {};
      let totalBuy = 0;
      let totalSell = 0;
      let poc = null;
      let pocVol = -1;

      for (const [price, cell] of map) {
        priceSet.add(price);
        const total = cell.buy + cell.sell;
        if (total > maxVol) maxVol = total;
        totalBuy += cell.buy;
        totalSell += cell.sell;
        if (total > pocVol) {
          pocVol = total;
          poc = price;
        }
        cells[price] = {
          buy: cell.buy,
          sell: cell.sell,
          delta: cell.buy - cell.sell,
          cancelBid: cell.cancelBid,
          cancelAsk: cell.cancelAsk,
          refillBid: cell.refillBid,
          refillAsk: cell.refillAsk,
          execBid: cell.execBid,
          execAsk: cell.execAsk,
          imbalance:
            cell.buy + cell.sell > 0
              ? (cell.buy - cell.sell) / (cell.buy + cell.sell)
              : 0,
        };
      }

      return {
        t,
        totalBuy,
        totalSell,
        delta: totalBuy - totalSell,
        poc,
        cells,
      };
    });

    // Prefer full ask+bid ladder around mid; keep traded prices that fall inside range
    let prices = [...priceSet].sort((a, b) => b - a);
    const maxRows = bidLevels + askLevels + 10;
    if (prices.length > maxRows) {
      const anchor =
        this.lastPrice ??
        (asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : prices[Math.floor(prices.length / 2)]);
      prices = prices
        .map((p) => ({ p, d: Math.abs(p - anchor) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, maxRows)
        .map((x) => x.p)
        .sort((a, b) => b - a);
    }

    return {
      intervalSec: this.intervalSec,
      columns,
      prices,
      resting,
      maxVol: maxVol || 1,
      maxResting: Math.max(1, ...Object.values(resting).map((r) => r.quantity)),
      lastPrice: this.lastPrice,
    };
  }
}
