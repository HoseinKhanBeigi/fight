/**
 * Forward-return backtest of pre-move snapshots.
 * Outcomes use prices after T; they never enter the live pre-move score.
 */

import { EPS } from "./math.js";

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function emptyBucket() {
  return {
    n: 0,
    hits: 0,
    returns: [],
    mae: [],
    mfe: [],
    continuations: 0,
    falsePositives: 0,
  };
}

export class PreMoveBacktest {
  constructor({ horizons = [1, 5, 10, 30, 60, 300], maxOpen = 800 } = {}) {
    this.horizons = [...horizons].sort((a, b) => a - b);
    this.maxHorizon = Math.max(...this.horizons);
    this.maxOpen = maxOpen;
    /** @type {Array<object>} */
    this.open = [];
    /** @type {Array<{t:number, price:number}>} */
    this.prices = [];
    /** @type {Map<string, Record<number, ReturnType<typeof emptyBucket>>>} */
    this.byState = new Map();
    this.completed = 0;
  }

  clear() {
    this.open = [];
    this.prices = [];
    this.byState.clear();
    this.completed = 0;
  }

  /**
   * Record a live snapshot at T. Only prices ≤ T are known here.
   */
  pushSnapshot({ t, price, state, up, down, imbalance, confidence }) {
    if (!Number.isFinite(price) || price <= 0) return;
    this.prices.push({ t, price });
    while (this.prices.length > 8000) this.prices.shift();

    if (!state || confidence < 30) return;
    if (
      state === "NO_PRESSURE" ||
      state === "BALANCED" ||
      state === "LOW_CONFIDENCE"
    ) {
      return;
    }
    this.open.push({
      t,
      price,
      state,
      up,
      down,
      imbalance,
      peak: price,
      trough: price,
      filled: {},
    });
    while (this.open.length > this.maxOpen) this.open.shift();
  }

  /**
   * Close horizons whose future window is now fully in the past.
   */
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
        const dir = row.imbalance >= 0 ? 1 : -1;
        const fav = dir > 0 ? (row.peak - row.price) / row.price : (row.price - row.trough) / row.price;
        const adv = dir > 0 ? (row.price - row.trough) / row.price : (row.peak - row.price) / row.price;
        row.filled[h] = { ret, mae: adv, mfe: fav };
        this._record(row.state, h, ret, dir, adv, fav);
        this.completed += 1;
      }
    }

    const keep = [];
    for (const row of this.open) {
      const age = now - row.t;
      if (age < this.maxHorizon + 2) keep.push(row);
    }
    this.open = keep;
  }

  _priceAt(ts) {
    let past = null;
    for (const p of this.prices) {
      if (p.t >= ts) return p.price;
      past = p.price;
    }
    return past;
  }

  _record(state, horizon, ret, dir, mae, mfe) {
    if (!this.byState.has(state)) {
      const rec = {};
      for (const h of this.horizons) rec[h] = emptyBucket();
      this.byState.set(state, rec);
    }
    const bucket = this.byState.get(state)[horizon];
    bucket.n += 1;
    bucket.returns.push(ret);
    bucket.mae.push(mae);
    bucket.mfe.push(mfe);
    if (ret * dir > 0) bucket.hits += 1;
    if (ret * dir > 0) bucket.continuations += 1;
    if (ret * dir <= 0) bucket.falsePositives += 1;
    if (bucket.returns.length > 400) {
      bucket.returns.shift();
      bucket.mae.shift();
      bucket.mfe.shift();
    }
  }

  summary() {
    /** @type {Record<string, object>} */
    const states = {};
    for (const [state, rec] of this.byState) {
      states[state] = {};
      for (const h of this.horizons) {
        const b = rec[h];
        if (!b.n) {
          states[state][h] = { n: 0 };
          continue;
        }
        const avg = b.returns.reduce((a, x) => a + x, 0) / b.returns.length;
        states[state][h] = {
          n: b.n,
          hitRate: b.hits / b.n,
          avgReturnBps: avg * 10_000,
          medianReturnBps: median(b.returns) * 10_000,
          maeBps: median(b.mae) * 10_000,
          mfeBps: median(b.mfe) * 10_000,
          continuation: b.continuations / b.n,
          falsePositive: b.falsePositives / b.n,
        };
      }
    }
    return {
      completed: this.completed,
      open: this.open.length,
      horizons: this.horizons,
      states,
    };
  }
}
