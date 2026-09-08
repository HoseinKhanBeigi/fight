/**
 * Historical normalization using only observations at or before T.
 * Supports rolling percentile, z-score, median/MAD, and regime buckets.
 */

import { clamp01, score100 } from "./math.js";

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stdev(arr, mu) {
  if (arr.length < 2) return 0;
  let s = 0;
  for (const v of arr) {
    const d = v - mu;
    s += d * d;
  }
  return Math.sqrt(s / (arr.length - 1));
}

function medianSorted(sorted) {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(sorted, med) {
  if (!sorted.length) return 0;
  const dev = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return medianSorted(dev);
}

export class PressureNormalizationEngine {
  constructor({ maxSamples = 400, minSamples = 8 } = {}) {
    this.maxSamples = maxSamples;
    this.minSamples = minSamples;
    /** @type {Map<string, number[]>} */
    this.series = new Map();
  }

  clear() {
    this.series.clear();
  }

  _arr(key) {
    if (!this.series.has(key)) this.series.set(key, []);
    return this.series.get(key);
  }

  /**
   * Read context from PRIOR samples only, then append the current value.
   * Never uses future observations.
   */
  observe(key, value, regime = "ALL") {
    if (!Number.isFinite(value)) {
      return {
        percentile: null,
        z: null,
        robustZ: null,
        band: "UNKNOWN",
        power: null,
        samples: 0,
      };
    }

    const allKey = `ALL:${key}`;
    const regimeKey = `${regime || "ALL"}:${key}`;
    const priorRegime = this._arr(regimeKey);
    const priorAll = this._arr(allKey);
    const useRegime = priorRegime.length >= this.minSamples;
    const prior = useRegime ? priorRegime : priorAll;

    const ctx = this._context(prior, value);
    this._push(allKey, value);
    if (regime && regime !== "ALL") this._push(regimeKey, value);
    return ctx;
  }

  percentileOf(key, value, regime = "ALL") {
    const regimeArr = this.series.get(`${regime}:${key}`);
    const all = this.series.get(`ALL:${key}`);
    const prior =
      regimeArr && regimeArr.length >= this.minSamples ? regimeArr : all;
    if (!prior || prior.length < this.minSamples) return null;
    let below = 0;
    for (const v of prior) if (v <= value) below += 1;
    return below / prior.length;
  }

  sampleCount(key) {
    return this.series.get(`ALL:${key}`)?.length || 0;
  }

  _push(key, value) {
    const arr = this._arr(key);
    arr.push(value);
    while (arr.length > this.maxSamples) arr.shift();
  }

  _context(prior, value) {
    const samples = prior.length;
    if (samples < this.minSamples) {
      return {
        percentile: null,
        z: null,
        robustZ: null,
        band: "UNKNOWN",
        power: null,
        samples,
      };
    }

    let below = 0;
    for (const v of prior) if (v <= value) below += 1;
    const percentile = below / prior.length;

    const mu = mean(prior);
    const sd = stdev(prior, mu);
    const z = sd > 1e-12 ? (value - mu) / sd : 0;

    const sorted = [...prior].sort((a, b) => a - b);
    const med = medianSorted(sorted);
    const m = mad(sorted, med);
    const robustZ = m > 1e-12 ? (0.6745 * (value - med)) / m : 0;

    // Flat series: percentile is uninformative — do not treat as EXTREME.
    const uninformative =
      sd <= 1e-12 || (Math.abs(mu) > 1e-12 && sd / Math.abs(mu) < 0.005 && Math.abs(value - mu) <= sd);

    return {
      percentile: uninformative ? 0.5 : percentile,
      z: uninformative ? 0 : z,
      robustZ: uninformative ? 0 : robustZ,
      band: this.band(uninformative ? 0.5 : percentile),
      power: uninformative ? 50 : score100(percentile),
      samples,
    };
  }

  band(percentile) {
    if (percentile == null) return "UNKNOWN";
    if (percentile < 0.2) return "VERY_LOW";
    if (percentile < 0.4) return "LOW";
    if (percentile < 0.6) return "NORMAL";
    if (percentile < 0.8) return "ELEVATED";
    if (percentile < 0.95) return "HIGH";
    return "EXTREME";
  }

  powerFromPercentile(p) {
    if (p == null) return null;
    return score100(p);
  }

  /** Inverse power: high when the raw value is historically low (thin books). */
  thinnessPower(ctx) {
    if (ctx.percentile == null) return null;
    return score100(1 - clamp01(ctx.percentile));
  }
}
