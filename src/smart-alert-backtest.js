/**
 * Forward-return tracker for smart vs raw aggression alerts.
 * Horizons: 1s, 5s, 10s, 30s, 60s, 300s.
 */

const EPS = 1e-12;

function emptyBucket() {
  return {
    n: 0,
    hits: 0,
    returns: [],
    meanReturn: 0,
    hitRate: 0,
  };
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export class SmartAlertBacktest {
  constructor({ horizons = [1, 5, 10, 30, 60, 300], maxOpen = 400 } = {}) {
    this.horizons = [...horizons].sort((a, b) => a - b);
    this.maxHorizon = Math.max(...this.horizons);
    this.maxOpen = maxOpen;
    /** @type {Array<object>} */
    this.open = [];
    /** @type {Array<{t:number, price:number}>} */
    this.prices = [];
    /** @type {Map<string, Record<number, ReturnType<typeof emptyBucket>>>} */
    this.byType = new Map();
    this.completed = 0;
  }

  clear() {
    this.open = [];
    this.prices = [];
    this.byType.clear();
    this.completed = 0;
  }

  pushAlert({ t, price, type, side, priority, spread, attack, defense }) {
    if (!Number.isFinite(price) || price <= 0 || !type) return;
    this.prices.push({ t, price });
    while (this.prices.length > 8000) this.prices.shift();

    this.open.push({
      t,
      price,
      type,
      side,
      priority,
      spread,
      attack,
      defense,
      peak: price,
      trough: price,
      filled: {},
    });
    while (this.open.length > this.maxOpen) this.open.shift();
  }

  tick(now, priceNow) {
    if (Number.isFinite(priceNow) && priceNow > 0) {
      const last = this.prices[this.prices.length - 1];
      if (!last || last.t !== now) this.prices.push({ t: now, price: priceNow });
    }

    for (const row of this.open) {
      if (priceNow > row.peak) row.peak = priceNow;
      if (priceNow < row.trough) row.trough = priceNow;
      const age = now - row.t;
      for (const h of this.horizons) {
        if (row.filled[h] != null) continue;
        if (age + 1e-6 < h) continue;
        const px = this._priceAt(row.t + h) ?? priceNow;
        const ret = (px - row.price) / Math.max(row.price, EPS);
        const dir = row.side === "sell" ? -1 : 1;
        const signed = ret * dir;
        row.filled[h] = { ret, signed };
        this._record(row.type, h, signed);
        this.completed += 1;
      }
    }

    this.open = this.open.filter((row) => now - row.t < this.maxHorizon + 2);
  }

  _priceAt(ts) {
    let past = null;
    for (const p of this.prices) {
      if (p.t >= ts) return p.price;
      past = p.price;
    }
    return past;
  }

  _record(type, h, signed) {
    if (!this.byType.has(type)) this.byType.set(type, {});
    const map = this.byType.get(type);
    if (!map[h]) map[h] = emptyBucket();
    const b = map[h];
    b.n += 1;
    b.returns.push(signed);
    if (signed > 0) b.hits += 1;
    while (b.returns.length > 500) b.returns.shift();
    b.meanReturn = mean(b.returns);
    b.hitRate = b.n ? b.hits / b.n : 0;
  }

  summary() {
    const byType = {};
    for (const [type, horizons] of this.byType.entries()) {
      byType[type] = {};
      for (const [h, b] of Object.entries(horizons)) {
        byType[type][h] = {
          n: b.n,
          hitRate: Number(b.hitRate.toFixed(3)),
          meanReturn: Number(b.meanReturn.toFixed(6)),
        };
      }
    }
    return {
      completed: this.completed,
      open: this.open.length,
      horizons: this.horizons,
      byType,
    };
  }
}
