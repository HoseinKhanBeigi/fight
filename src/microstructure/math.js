/** Shared score helpers for the pre-move pressure stack. */

export const EPS = 1e-12;

export function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

export function score100(x) {
  return Math.round(clamp01(x) * 100);
}

export function safeDiv(a, b) {
  return a / Math.max(b, EPS);
}

export function round1(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

/**
 * Combine 0–100 features with signed weights into a 0–100 score.
 * Positive weights raise the score when the feature is high.
 * Negative weights lower it (replenishment, survival, defense).
 */
export function combineWeighted(weights, features) {
  let s = 0;
  let minS = 0;
  let maxS = 0;
  /** @type {Record<string, number>} */
  const contributions = {};

  for (const [key, w] of Object.entries(weights)) {
    const x = clamp01((Number(features[key]) || 0) / 100);
    s += w * x;
    if (w >= 0) maxS += w;
    else minS += w;
    contributions[key] = w * x;
  }

  const span = Math.max(maxS - minS, EPS);
  const score = score100((s - minS) / span);

  /** @type {Record<string, number>} */
  const points = {};
  for (const [key, c] of Object.entries(contributions)) {
    points[key] = Math.round((c / span) * 1000) / 10;
  }

  return { score, contributions: points, raw: s };
}

export function invertScore(score) {
  return 100 - clamp(Math.round(Number(score) || 0), 0, 100);
}

export function signed(n, digits = 0) {
  if (!Number.isFinite(n)) return "0";
  const v = digits ? n.toFixed(digits) : String(Math.round(n));
  if (n > 0) return `+${v}`;
  return String(v);
}
