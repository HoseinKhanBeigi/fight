/** Causal stats helpers for path-test. Independent of live scoring engines. */

export const EPS = 1e-12;

export function finite(x) {
  return Number.isFinite(Number(x)) ? Number(x) : null;
}

export function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

export function clamp01(x) {
  return clamp(x, 0, 1);
}

export function mean(arr) {
  if (!arr?.length) return null;
  let s = 0;
  let n = 0;
  for (const v of arr) {
    if (!Number.isFinite(v)) continue;
    s += v;
    n += 1;
  }
  return n ? s / n : null;
}

export function median(arr) {
  const xs = (arr || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(arr, q) {
  const xs = (arr || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const pos = (xs.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export function stdev(arr, mu = null) {
  const xs = (arr || []).filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const m = mu == null ? mean(xs) : mu;
  let s = 0;
  for (const v of xs) {
    const d = v - m;
    s += d * d;
  }
  return Math.sqrt(s / (xs.length - 1));
}

export function mad(arr, med = null) {
  const xs = (arr || []).filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  const m = med == null ? median(xs) : med;
  return median(xs.map((v) => Math.abs(v - m)));
}

/** Percentile of `value` among PRIOR samples only (value itself is not in `prior`). */
export function percentileRank(prior, value) {
  if (!Number.isFinite(value) || !prior?.length) return null;
  let below = 0;
  for (const v of prior) if (Number.isFinite(v) && v <= value) below += 1;
  return below / prior.length;
}

export function zScore(prior, value) {
  if (!Number.isFinite(value) || !prior || prior.length < 2) return null;
  const mu = mean(prior);
  const sd = stdev(prior, mu);
  if (mu == null || sd == null || sd <= EPS) return 0;
  return (value - mu) / sd;
}

export function robustZ(prior, value) {
  if (!Number.isFinite(value) || !prior?.length) return null;
  const med = median(prior);
  const m = mad(prior, med);
  if (med == null) return null;
  if (m == null || m <= EPS) return 0;
  return (0.6745 * (value - med)) / m;
}

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  const a = [];
  const b = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      a.push(xs[i]);
      b.push(ys[i]);
    }
  }
  if (a.length < 8) return null;
  const ma = mean(a);
  const mb = mean(b);
  const sa = stdev(a, ma);
  const sb = stdev(b, mb);
  if (ma == null || mb == null || sa == null || sb == null || sa <= EPS || sb <= EPS) return null;
  let cov = 0;
  for (let i = 0; i < a.length; i++) cov += (a[i] - ma) * (b[i] - mb);
  return cov / ((a.length - 1) * sa * sb);
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(hits, n, z = 1.96) {
  if (!n || n <= 0) return { lo: null, hi: null };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    lo: clamp01((center - margin) / denom),
    hi: clamp01((center + margin) / denom),
  };
}

export function signedBps(frac) {
  if (!Number.isFinite(frac)) return null;
  return frac * 10_000;
}

/**
 * Combine 0–100 features with signed weights into a 0–100 score.
 * Null features are skipped — never coerced to 0.
 */
export function combineWeighted(weights, features) {
  let s = 0;
  let minS = 0;
  let maxS = 0;
  let used = 0;
  const contributions = {};

  for (const [key, w] of Object.entries(weights)) {
    const raw = features[key];
    if (!Number.isFinite(raw)) continue;
    const x = clamp01(Number(raw) / 100);
    s += w * x;
    if (w >= 0) maxS += w;
    else minS += w;
    contributions[key] = w * x;
    used += 1;
  }

  if (used === 0) return { score: null, contributions: {}, used: 0 };

  const span = Math.max(maxS - minS, EPS);
  const score = Math.round(clamp01((s - minS) / span) * 100);
  return { score, contributions, used };
}

export function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freezeDeep(v);
  }
  return value;
}

export function mapTo100(value, lo, hi) {
  if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return null;
  }
  return Math.round(clamp01((value - lo) / (hi - lo)) * 100);
}

/**
 * Rolling causal normalizer.
 * `observe` reads PRIOR samples only, then appends the current value.
 */
export class CausalNormalizer {
  constructor({ maxSamples = 480, minSamples = 8 } = {}) {
    this.maxSamples = maxSamples;
    this.minSamples = minSamples;
    /** @type {Map<string, number[]>} */
    this.series = new Map();
  }

  clear() {
    this.series.clear();
  }

  sampleCount(key) {
    return this.series.get(key)?.length || 0;
  }

  /** Context from samples strictly before the current value. */
  peek(key, value) {
    if (!Number.isFinite(value)) {
      return { percentile: null, percentile100: null, z: null, robustZ: null, power: null, samples: 0 };
    }
    const prior = this.series.get(key) || [];
    const samples = prior.length;
    if (samples < this.minSamples) {
      return { percentile: null, percentile100: null, z: null, robustZ: null, power: null, samples };
    }
    const percentile = percentileRank(prior, value);
    const z = zScore(prior, value);
    const rz = robustZ(prior, value);
    const power = percentile == null ? null : Math.round(clamp01(percentile) * 100);
    return {
      percentile,
      percentile100: power,
      z,
      robustZ: rz,
      power,
      samples,
    };
  }

  observe(key, value) {
    const ctx = this.peek(key, value);
    if (Number.isFinite(value)) {
      if (!this.series.has(key)) this.series.set(key, []);
      const arr = this.series.get(key);
      arr.push(value);
      while (arr.length > this.maxSamples) arr.shift();
    }
    return ctx;
  }
}
