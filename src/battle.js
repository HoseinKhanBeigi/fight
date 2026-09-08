/**
 * Market battle engine: ATTACK + DEFENSE + RESPONSE → STATE + WHY.
 *
 * Attack = normalized aggressive executed flow ONLY.
 * Defense = normalized passive book defense ONLY.
 * Absorption / price efficiency remain RESPONSE results, not attack inputs.
 */

const EPS = 1e-12;

const ATTACK_WEIGHTS = {
  aggression: 0.28,
  velocity: 0.16,
  intensity: 0.12,
  imbalance: 0.14,
  large: 0.12,
  delta: 0.09,
  cvd: 0.09,
};

const DEFENSE_WEIGHTS = {
  depth: 0.16,
  nearTouch: 0.12,
  replenishment: 0.16,
  survival: 0.16,
  persistence: 0.1,
  cancellation: -0.12,
  withdrawal: -0.1,
  consumption: -0.1,
  defenseWeakening: -0.08,
};

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function score100(x) {
  return Math.round(clamp01(x) * 100);
}

function safeDiv(a, b) {
  return a / Math.max(b, EPS);
}

function avg(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** Rolling ring of samples for percentile / z-score context. */
export class RollingHistory {
  constructor(maxSamples = 240) {
    this.maxSamples = maxSamples;
    /** @type {Map<string, number[]>} */
    this.series = new Map();
  }

  clear() {
    this.series.clear();
  }

  push(key, value) {
    if (!Number.isFinite(value)) return;
    if (!this.series.has(key)) this.series.set(key, []);
    const arr = this.series.get(key);
    arr.push(value);
    while (arr.length > this.maxSamples) arr.shift();
  }

  percentile(key, value) {
    const arr = this.series.get(key);
    if (!arr || arr.length < 8) return null;
    if (!Number.isFinite(value)) return null;
    let below = 0;
    for (const v of arr) if (v <= value) below += 1;
    return below / arr.length;
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

  /** Map percentile → 0–100. Null percentile → null (not fake mid-score). */
  powerFromPercentile(p) {
    if (p == null) return null;
    return score100(p);
  }

  /**
   * Observe raw value → rolling percentile power.
   * Does not push when value is non-finite (NO_DATA).
   */
  observe(key, value) {
    if (!Number.isFinite(value)) {
      return { percentile: null, power: null, samples: this.series.get(key)?.length || 0 };
    }
    const p = this.percentile(key, value);
    this.push(key, value);
    return {
      percentile: p,
      power: this.powerFromPercentile(p),
      samples: this.series.get(key)?.length || 0,
    };
  }
}

function priceMoveBps(priceNow, priceThen) {
  if (!Number.isFinite(priceNow) || !Number.isFinite(priceThen) || priceThen <= 0) return 0;
  return ((priceNow - priceThen) / priceThen) * 10_000;
}

function priceAtLookback(priceHistory, now, lookbackSec) {
  if (!priceHistory?.length) return null;
  const target = now - lookbackSec;
  let past = priceHistory[0].price;
  for (const { ts, price } of priceHistory) {
    if (ts >= target) return past;
    past = price;
  }
  return past;
}

function churnLabel(ratio, pct) {
  if (pct != null) {
    if (pct >= 0.95) return "EXTREME_CHURN";
    if (pct >= 0.8) return "HIGH_CHURN";
    if (pct >= 0.4) return "NORMAL_CHURN";
    return "LOW_CHURN";
  }
  if (ratio >= 8) return "EXTREME_CHURN";
  if (ratio >= 3) return "HIGH_CHURN";
  if (ratio >= 1) return "NORMAL_CHURN";
  return "LOW_CHURN";
}

function combineNormalized(weights, features) {
  let s = 0;
  let minS = 0;
  let maxS = 0;
  let used = 0;
  /** @type {Record<string, number>} */
  const contributions = {};

  for (const [key, w] of Object.entries(weights)) {
    const raw = features[key];
    if (!Number.isFinite(raw)) continue;
    const x = clamp01(raw / 100);
    s += w * x;
    if (w >= 0) maxS += w;
    else minS += w;
    contributions[key] = Math.round(w * x * 1000) / 10;
    used += 1;
  }

  if (used === 0) return { score: null, contributions };
  const span = Math.max(maxS - minS, EPS);
  return { score: score100((s - minS) / span), contributions };
}

function wallPersistenceRaw(wall, now) {
  if (!wall || !wall.active) return 0;
  const lifeSec = Math.max(0, (now - (wall.createdAt || now)) );
  const lifeScore = clamp01(lifeSec / 30);
  const sizeHold = clamp01(safeDiv(wall.currentSize || 0, Math.max(wall.initialSize || 0, EPS)));
  const cancelPenalty = clamp01(wall.cancelRatio || 0);
  const depPenalty = clamp01(wall.depletionRatio || 0);
  return clamp01(0.45 * lifeScore + 0.35 * sizeHold + 0.2 * (1 - Math.max(cancelPenalty, depPenalty)));
}

function averageDepthOverWindow(depthHist, now, windowSec, side) {
  if (!depthHist?.length) return { depth: null, near: null, samples: 0 };
  const t0 = now - windowSec;
  const depths = [];
  const nears = [];
  for (const row of depthHist) {
    if (row.t < t0 || row.t > now) continue;
    if (side === "ask") {
      if (Number.isFinite(row.askDepth)) depths.push(row.askDepth);
      if (Number.isFinite(row.nearAsk)) nears.push(row.nearAsk);
    } else {
      if (Number.isFinite(row.bidDepth)) depths.push(row.bidDepth);
      if (Number.isFinite(row.nearBid)) nears.push(row.nearBid);
    }
  }
  return { depth: avg(depths), near: avg(nears), samples: depths.length };
}

/**
 * Pure attack power from aggressive trade features only (0–100 or null).
 */
function scoreAttackPower({
  history,
  prefix,
  windowSec,
  aggressiveVolume,
  tradeCount,
  largeTradeVolume,
  opposingAggressiveVolume,
  netDelta,
  cvdDelta,
  missingTrades,
}) {
  if (missingTrades) {
    return {
      power: null,
      features: null,
      contributions: {},
      percentiles: {},
      dataQuality: "NO_DATA",
    };
  }

  const tot = Math.max(0, (aggressiveVolume || 0) + (opposingAggressiveVolume || 0));
  const velocity = safeDiv(aggressiveVolume, Math.max(windowSec, 1));
  const intensity = safeDiv(tradeCount || 0, Math.max(windowSec, 1));
  const imbalance = tot > 0 ? clamp01(aggressiveVolume / tot) : 0;
  const largeShare = safeDiv(largeTradeVolume || 0, Math.max(aggressiveVolume, EPS));
  // Favorable delta for this side (buy: +netDelta, sell: -netDelta)
  const deltaFavor = Math.max(0, netDelta || 0);
  const cvdFavor = Math.max(0, cvdDelta || 0);

  const k = (name) => `${prefix}:${windowSec}:atk:${name}`;
  const aggO = history.observe(k("agg"), aggressiveVolume);
  const velO = history.observe(k("vel"), velocity);
  const intO = history.observe(k("int"), intensity);
  const imbO = history.observe(k("imb"), imbalance);
  const largeO = history.observe(k("large"), largeShare);
  const deltaO = history.observe(k("delta"), deltaFavor);
  const cvdO = history.observe(k("cvd"), cvdFavor);

  const features = {
    aggression: aggO.power,
    velocity: velO.power,
    intensity: intO.power,
    imbalance: imbO.power,
    large: largeO.power,
    delta: deltaO.power,
    cvd: cvdO.power,
  };

  // Warm-up: if any core feature lacks history, keep power null (LOW_CONFIDENCE), not fake 50.
  const coreReady =
    aggO.power != null && velO.power != null && imbO.power != null;
  const combo = coreReady ? combineNormalized(ATTACK_WEIGHTS, features) : { score: null, contributions: {} };

  return {
    power: combo.score,
    features,
    contributions: combo.contributions,
    percentiles: {
      aggression: aggO.percentile,
      velocity: velO.percentile,
      intensity: intO.percentile,
      imbalance: imbO.percentile,
      large: largeO.percentile,
      delta: deltaO.percentile,
      cvd: cvdO.percentile,
    },
    dataQuality: combo.score == null ? "LOW_CONFIDENCE" : "OK",
    raw: {
      aggressiveVolume,
      velocity,
      intensity,
      imbalance,
      largeShare,
      deltaFavor,
      cvdFavor,
      zeroKind: aggressiveVolume === 0 ? "REAL_ZERO" : "POSITIVE",
    },
  };
}

/**
 * Full passive defense power (0–100 or null). Windowed depth preferred.
 */
function scoreDefensePower({
  history,
  prefix,
  windowSec,
  consumed,
  cancelled,
  replenished,
  stacked,
  windowedDepth,
  windowedNear,
  currentLiquidity,
  wall,
  now,
  missingBook,
  staleBook,
}) {
  if (missingBook) {
    return {
      power: null,
      features: null,
      contributions: {},
      dataQuality: "NO_DATA",
    };
  }
  if (staleBook) {
    return {
      power: null,
      features: null,
      contributions: {},
      dataQuality: "STALE",
    };
  }

  const depthForDefense = Number.isFinite(windowedDepth) ? windowedDepth : currentLiquidity;
  const nearForDefense = Number.isFinite(windowedNear) ? windowedNear : currentLiquidity;
  const depthSource = Number.isFinite(windowedDepth) ? "WINDOWED_DEPTH" : "CURRENT_DEPTH";

  const netWithdrawal = Math.max(0, (cancelled || 0) - (replenished || 0));
  const survivalRaw = clamp01(
    1 -
      0.45 * clamp01(safeDiv(consumed || 0, Math.max(depthForDefense || 0, consumed || 0, EPS))) -
      0.35 * clamp01(safeDiv(netWithdrawal, Math.max((cancelled || 0) + (replenished || 0), EPS))) +
      0.25 * clamp01(safeDiv(replenished || 0, Math.max(consumed || 0, EPS)))
  );
  const withdrawalRaw = clamp01(safeDiv(netWithdrawal, Math.max((cancelled || 0) + (replenished || 0), EPS)));
  const persistRaw = wallPersistenceRaw(wall, now);
  const weakenRaw = clamp01(
    0.35 * clamp01(safeDiv(cancelled || 0, Math.max(depthForDefense || 0, EPS))) +
      0.35 * withdrawalRaw +
      0.3 * clamp01(safeDiv(consumed || 0, Math.max((consumed || 0) + (replenished || 0), EPS)))
  );

  const k = (name) => `${prefix}:${windowSec}:def:${name}`;
  const depthO = history.observe(k("depth"), depthForDefense || 0);
  const nearO = history.observe(k("near"), nearForDefense || 0);
  const refillO = history.observe(k("refill"), replenished || 0);
  const survO = history.observe(k("surv"), survivalRaw);
  const persO = history.observe(k("pers"), persistRaw);
  const cancelO = history.observe(k("cancel"), cancelled || 0);
  const withO = history.observe(k("with"), withdrawalRaw);
  const consO = history.observe(k("cons"), consumed || 0);
  const weakO = history.observe(k("weak"), weakenRaw);

  const features = {
    depth: depthO.power,
    nearTouch: nearO.power,
    replenishment: refillO.power,
    survival: survO.power,
    persistence: persO.power,
    cancellation: cancelO.power,
    withdrawal: withO.power,
    consumption: consO.power,
    defenseWeakening: weakO.power,
  };

  const coreReady = depthO.power != null && survO.power != null && refillO.power != null;
  const combo = coreReady ? combineNormalized(DEFENSE_WEIGHTS, features) : { score: null, contributions: {} };

  const grossChurn = (stacked || 0) + (replenished || 0) + (cancelled || 0) + (consumed || 0);
  const churnRatio = safeDiv(grossChurn, Math.max(depthForDefense || 0, EPS));

  return {
    power: combo.score,
    features,
    contributions: combo.contributions,
    dataQuality: combo.score == null ? "LOW_CONFIDENCE" : "OK",
    depthSource,
    windowedDepth: Number.isFinite(windowedDepth) ? windowedDepth : null,
    windowedNear: Number.isFinite(windowedNear) ? windowedNear : null,
    currentLiquidity: Number.isFinite(currentLiquidity) ? currentLiquidity : null,
    survivalRaw,
    withdrawalRaw,
    persistRaw,
    weakenRaw,
    netWithdrawal,
    netAddition: Math.max(0, (replenished || 0) - (cancelled || 0)),
    behavioralNetChange: (stacked || 0) + (replenished || 0) - (cancelled || 0) - (consumed || 0),
    churnRatio,
    cancelPct: cancelO.percentile,
    refillPct: refillO.percentile,
    consPct: consO.percentile,
    withPct: withO.percentile,
    churnPct: null,
  };
}

/**
 * @param {object} opts
 */
export function buildBattleCard({
  side, // 'buy' | 'sell'
  windowSec,
  aggressiveVolume,
  opposingAggressiveVolume,
  consumed, // askExec or bidExec — passive liquidity traded away
  cancelled,
  replenished, // refill
  stacked = 0,
  currentLiquidity,
  windowedDepth = null,
  windowedNear = null,
  priceNow,
  priceThen,
  history,
  tradeCount = 0,
  largeTradeVolume = 0,
  netDelta = 0,
  cvdDelta = 0,
  wall = null,
  now = Date.now() / 1000,
  dataQuality = { trades: true, book: true, stale: false },
}) {
  const isBuy = side === "buy";
  const prefix = isBuy ? "ask" : "bid";

  const missingTrades = dataQuality.trades === false;
  const missingBook = dataQuality.book === false;
  const staleBook = !!dataQuality.stale;

  // Side-favorable delta: buy uses +netDelta, sell uses -netDelta
  const sideNetDelta = isBuy ? netDelta : -netDelta;
  const sideCvdDelta = isBuy ? cvdDelta : -cvdDelta;

  const attackScore = scoreAttackPower({
    history,
    prefix: isBuy ? "buy" : "sell",
    windowSec,
    aggressiveVolume: missingTrades ? null : aggressiveVolume,
    tradeCount: missingTrades ? null : tradeCount,
    largeTradeVolume: missingTrades ? null : largeTradeVolume,
    opposingAggressiveVolume: missingTrades ? null : opposingAggressiveVolume,
    netDelta: missingTrades ? null : sideNetDelta,
    cvdDelta: missingTrades ? null : sideCvdDelta,
    missingTrades,
  });

  const defenseScore = scoreDefensePower({
    history,
    prefix,
    windowSec,
    consumed: missingBook || staleBook ? null : consumed,
    cancelled: missingBook || staleBook ? null : cancelled,
    replenished: missingBook || staleBook ? null : replenished,
    stacked: missingBook || staleBook ? null : stacked,
    windowedDepth,
    windowedNear,
    currentLiquidity,
    wall,
    now,
    missingBook,
    staleBook,
  });

  // Push churn for band labels only (defense path)
  const churnRatio = defenseScore.churnRatio ?? 0;
  const kChurn = `${prefix}:${windowSec}:churn`;
  let churnPct = null;
  if (!missingBook && !staleBook && history) {
    churnPct = history.percentile(kChurn, churnRatio);
    history.push(kChurn, churnRatio);
  }

  const power = attackScore.power;
  const passiveDefense = defenseScore.power;
  const survival = defenseScore.survivalRaw != null ? score100(defenseScore.survivalRaw) : null;
  const withdrawal = defenseScore.withdrawalRaw != null ? score100(defenseScore.withdrawalRaw) : null;

  const moveBps = priceMoveBps(priceNow, priceThen);
  const directionalBps = isBuy ? moveBps : -moveBps;
  const effort = Math.max(aggressiveVolume || 0, EPS);
  const rawEff = clamp01(safeDiv(Math.max(0, directionalBps), safeDiv(effort, 1_000_000) * 12));
  const inverseEff = 1 - rawEff;
  const kEff = `${prefix}:${windowSec}:eff`;
  let effPct = null;
  if (!missingTrades && history) {
    effPct = history.percentile(kEff, rawEff);
    history.push(kEff, rawEff);
  }
  const efficiency = effPct != null ? history.powerFromPercentile(effPct) : missingTrades ? null : score100(rawEff);

  const consumptionStrength = clamp01(
    safeDiv(consumed || 0, Math.max(aggressiveVolume || 0, (currentLiquidity || 0) * 0.05, EPS))
  );
  const replenishStrength = clamp01(
    safeDiv(replenished || 0, Math.max(consumed || 0, (currentLiquidity || 0) * 0.05, EPS))
  );

  // Absorption = RESPONSE result. Uses pure attack power (not liquidity ratios).
  let absorptionScore = null;
  if (power != null && survival != null && efficiency != null) {
    const absorption01 = clamp01(
      0.22 * (power / 100) +
        0.18 * consumptionStrength +
        0.22 * replenishStrength +
        0.2 * (survival / 100) +
        0.18 * inverseEff
    );
    absorptionScore = score100(absorption01);
  }

  const estimatedAbsorbedFlow =
    power == null || missingTrades
      ? null
      : (aggressiveVolume || 0) *
        clamp01(consumptionStrength) *
        clamp01(replenishStrength) *
        clamp01(0.35 + 0.65 * inverseEff);

  const velocity = missingTrades ? null : safeDiv(aggressiveVolume || 0, Math.max(windowSec, 1));

  const battleSpread =
    power != null && passiveDefense != null ? Math.round(power - passiveDefense) : null;

  const lowConfidence =
    attackScore.dataQuality === "LOW_CONFIDENCE" ||
    defenseScore.dataQuality === "LOW_CONFIDENCE" ||
    (power == null && !missingTrades) ||
    (passiveDefense == null && !missingBook && !staleBook);

  const attack = {
    aggressiveVolume: missingTrades ? null : aggressiveVolume,
    power,
    AggressiveBuyPower: isBuy ? power : undefined,
    AggressiveSellPower: isBuy ? undefined : power,
    percentile:
      attackScore.percentiles?.aggression == null
        ? null
        : Math.round(attackScore.percentiles.aggression * 100),
    percentileBand: history?.band(attackScore.percentiles?.aggression) || "UNKNOWN",
    velocity,
    largeVolume: missingTrades ? null : largeTradeVolume,
    tradeCount: missingTrades ? null : tradeCount,
    intensity: missingTrades ? null : attackScore.raw?.intensity ?? null,
    imbalance: missingTrades ? null : attackScore.raw?.imbalance ?? null,
    delta: missingTrades ? null : attackScore.raw?.deltaFavor ?? null,
    cvd: missingTrades ? null : attackScore.raw?.cvdFavor ?? null,
    features: attackScore.features,
    contributions: attackScore.contributions,
    zeroKind: attackScore.raw?.zeroKind || null,
    dataQuality: attackScore.dataQuality,
  };

  const defense = {
    power: passiveDefense,
    PassiveSellerDefense: isBuy ? passiveDefense : undefined,
    PassiveBuyerDefense: isBuy ? undefined : passiveDefense,
    currentLiquidity: missingBook || staleBook ? null : currentLiquidity,
    windowedDepth: defenseScore.windowedDepth,
    windowedNear: defenseScore.windowedNear,
    depthSource: defenseScore.depthSource || (missingBook || staleBook ? null : "CURRENT_DEPTH"),
    consumed: missingBook || staleBook ? null : consumed,
    cancelled: missingBook || staleBook ? null : cancelled,
    replenished: missingBook || staleBook ? null : replenished,
    stacked: missingBook || staleBook ? null : stacked || 0,
    netWithdrawal: missingBook || staleBook ? null : defenseScore.netWithdrawal ?? null,
    netAddition: missingBook || staleBook ? null : defenseScore.netAddition ?? null,
    behavioralNetChange: missingBook || staleBook ? null : defenseScore.behavioralNetChange ?? null,
    survival: missingBook || staleBook ? null : survival,
    withdrawal: missingBook || staleBook ? null : withdrawal,
    persistence: missingBook || staleBook ? null : score100(defenseScore.persistRaw || 0),
    defenseWeakening: missingBook || staleBook ? null : score100(defenseScore.weakenRaw || 0),
    features: defenseScore.features,
    contributions: defenseScore.contributions,
    churnRatio: missingBook || staleBook ? null : churnRatio,
    churnLabel: missingBook || staleBook ? "UNKNOWN" : churnLabel(churnRatio, churnPct),
    cancelPercentile:
      defenseScore.cancelPct == null ? null : Math.round(defenseScore.cancelPct * 100),
    cancelBand: history?.band(defenseScore.cancelPct) || "UNKNOWN",
    refillPercentile:
      defenseScore.refillPct == null ? null : Math.round(defenseScore.refillPct * 100),
    refillBand: history?.band(defenseScore.refillPct) || "UNKNOWN",
    consumePercentile:
      defenseScore.consPct == null ? null : Math.round(defenseScore.consPct * 100),
    consumeBand: history?.band(defenseScore.consPct) || "UNKNOWN",
    withdrawalPercentile:
      defenseScore.withPct == null ? null : Math.round(defenseScore.withPct * 100),
    dataQuality: defenseScore.dataQuality,
  };

  const response = {
    priceMoveBps: moveBps,
    directionalBps,
    efficiency,
    efficiencyLabel: isBuy ? "UpwardPriceEfficiency" : "DownwardPriceEfficiency",
    absorptionScore,
    absorptionLabel: isBuy ? "SellerAbsorption" : "BuyerAbsorption",
    estimatedAbsorbedFlow,
  };

  const { state, why, evidence, passiveState } = classifyBattle({
    isBuy,
    attack,
    defense,
    response,
    battleSpread,
    lowConfidence,
    missingTrades,
    missingBook,
    staleBook,
    cancelPct: defenseScore.cancelPct,
    refillPct: defenseScore.refillPct,
    consPct: defenseScore.consPct,
    withPct: defenseScore.withPct,
    aggPct: attackScore.percentiles?.aggression,
  });

  return {
    side,
    windowSec,
    attack,
    defense,
    response,
    battleSpread,
    UpsideBattleSpread: isBuy ? battleSpread : undefined,
    DownsideBattleSpread: isBuy ? undefined : battleSpread,
    state,
    passiveState,
    why,
    evidence,
    labels: {
      aggressive: isBuy ? "Aggressive Buy Volume" : "Aggressive Sell Volume",
      consumed: isBuy ? "Ask Liquidity Consumed" : "Bid Liquidity Consumed",
      cancelled: isBuy ? "Ask Cancelled" : "Bid Cancelled",
      replenished: isBuy ? "Ask Replenished" : "Bid Replenished",
      liquidity: isBuy ? "Ask Liquidity" : "Bid Liquidity",
      depthSource: defense.depthSource,
      absorption: isBuy ? "Seller Absorption" : "Buyer Absorption",
      efficiency: isBuy ? "Upward Price Efficiency" : "Downward Price Efficiency",
      attackPower: isBuy ? "AggressiveBuyPower" : "AggressiveSellPower",
      defensePower: isBuy ? "PassiveSellerDefense" : "PassiveBuyerDefense",
      battleSpread: isBuy ? "UpsideBattleSpread" : "DownsideBattleSpread",
    },
  };
}

function classifyBattle({
  isBuy,
  attack,
  defense,
  response,
  battleSpread,
  lowConfidence,
  missingTrades,
  missingBook,
  staleBook,
  cancelPct,
  refillPct,
  consPct,
  withPct,
  aggPct,
}) {
  if (missingTrades || missingBook) {
    return {
      state: "NO_DATA",
      passiveState: "NO_DATA",
      why: missingTrades
        ? "Trade data unavailable — AggressivePower is null (not zero)."
        : "Order book data unavailable — PassiveDefense is null (not zero).",
      evidence: [],
    };
  }
  if (staleBook) {
    return {
      state: "STALE",
      passiveState: "STALE",
      why: "Order book data is stale — PassiveDefense suppressed.",
      evidence: [],
    };
  }
  if (lowConfidence || attack.power == null || defense.power == null) {
    return {
      state: "LOW_CONFIDENCE",
      passiveState: "LOW_CONFIDENCE",
      why: "Insufficient normalized history or weak signal — strong battle labels suppressed.",
      evidence: [],
    };
  }

  const power = attack.power;
  const passiveDefense = defense.power;
  const survival = defense.survival ?? 50;
  const withdrawal = defense.withdrawal ?? 0;
  const eff = response.efficiency ?? 50;
  const absScore = response.absorptionScore;
  const churn = defense.churnLabel;
  const depth = defense.windowedDepth ?? defense.currentLiquidity ?? 0;
  const agg = attack.aggressiveVolume || 0;
  const meaningful = agg > 0 && (defense.consumed > 0 || defense.cancelled > 0 || defense.replenished > 0);

  if (!meaningful && power < 35) {
    return {
      state: "NO_MEANINGFUL_BATTLE",
      passiveState: isBuy ? "ASK_LIQUIDITY_STABLE" : "BID_LIQUIDITY_STABLE",
      why: "Aggression and passive turnover are both too small to call a clear battle.",
      evidence: [
        { k: "Attack power", v: `${power}/100` },
        { k: "Defense power", v: `${passiveDefense}/100` },
        { k: "Aggressive volume", v: fmtShort(agg) },
      ],
    };
  }

  const cancelExtreme = (cancelPct ?? 0) >= 0.95;
  const refillExtreme = (refillPct ?? 0) >= 0.95;
  const consHigh =
    (consPct ?? 0) >= 0.8 || defense.consumeBand === "HIGH" || defense.consumeBand === "EXTREME";
  const withHigh = (withPct ?? 0) >= 0.8 || withdrawal >= 60;
  const attackHigh = power >= 65 || (aggPct ?? 0) >= 0.7;
  const attackMod = power >= 45;
  const defenseStrong = passiveDefense >= 60;
  const defenseWeak = passiveDefense <= 40;

  let passiveState = isBuy ? "ASK_LIQUIDITY_STABLE" : "BID_LIQUIDITY_STABLE";
  if (cancelExtreme) passiveState = isBuy ? "ASK_CANCELLATION_SURGE" : "BID_CANCELLATION_SURGE";
  else if (refillExtreme && !withHigh) passiveState = isBuy ? "ASK_REPLENISHMENT_SURGE" : "BID_REPLENISHMENT_SURGE";
  else if (withHigh) passiveState = isBuy ? "ASK_LIQUIDITY_WITHDRAWING" : "BID_LIQUIDITY_WITHDRAWING";
  else if ((defense.behavioralNetChange || 0) > 0 && (refillPct ?? 0.5) >= 0.55)
    passiveState = isBuy ? "ASK_LIQUIDITY_BUILDING" : "BID_LIQUIDITY_BUILDING";
  else if (consHigh) passiveState = isBuy ? "ASK_CONSUMPTION_HIGH" : "BID_CONSUMPTION_HIGH";
  else if (survival >= 70) passiveState = isBuy ? "ASK_SURVIVING" : "BID_SURVIVING";
  else if (survival <= 40 || defenseWeak) passiveState = isBuy ? "ASK_DEFENSE_WEAKENING" : "BID_DEFENSE_WEAKENING";

  const evidence = [
    { k: isBuy ? "AggressiveBuyPower" : "AggressiveSellPower", v: `${power}/100` },
    { k: isBuy ? "PassiveSellerDefense" : "PassiveBuyerDefense", v: `${passiveDefense}/100` },
    { k: "BattleSpread", v: battleSpread == null ? "n/a" : String(battleSpread) },
    { k: "Depth source", v: defense.depthSource || "n/a" },
    { k: "Cancel percentile", v: cancelPct == null ? "n/a" : `${Math.round(cancelPct * 100)}th` },
    { k: "Replenish percentile", v: refillPct == null ? "n/a" : `${Math.round(refillPct * 100)}th` },
    { k: "Net withdrawal", v: fmtShort(defense.netWithdrawal) },
    { k: "Survival", v: `${survival}/100` },
    { k: isBuy ? "Up efficiency" : "Down efficiency", v: `${eff}/100` },
    {
      k: isBuy ? "Seller absorption" : "Buyer absorption",
      v: absScore == null ? "n/a" : `${absScore}/100`,
    },
    { k: "Churn", v: churn },
    {
      k: "Price move",
      v: `${response.priceMoveBps >= 0 ? "+" : ""}${response.priceMoveBps.toFixed(1)} bps`,
    },
  ];

  // Do not emit absorption / winning / vacuum without absorption score + both powers
  if (absScore != null && attackHigh && absScore >= 65 && eff <= 40 && survival >= 55 && defenseStrong) {
    return {
      state: isBuy ? "SELLER_ABSORPTION" : "BUYER_ABSORPTION",
      passiveState,
      why: isBuy
        ? "Buy aggression is elevated, but ask defense holds and upside displacement stays weak."
        : "Sell aggression is elevated, but bid defense holds and downside displacement stays weak.",
      evidence,
    };
  }

  if (attackMod && withHigh && depth > 0 && survival <= 45 && defenseWeak && eff >= 55) {
    return {
      state: isBuy ? "UPSIDE_LIQUIDITY_VACUUM" : "DOWNSIDE_LIQUIDITY_VACUUM",
      passiveState,
      why: isBuy
        ? "Asks are withdrawing while buy pressure converts into upside — resistance above is thinning."
        : "Bids are withdrawing while sell pressure converts into downside — support below is thinning.",
      evidence,
    };
  }

  if (attackHigh && consHigh && (refillPct ?? 1) < 0.55 && survival <= 45 && defenseWeak && eff >= 55) {
    return {
      state: isBuy ? "BUYERS_WINNING" : "SELLERS_WINNING",
      passiveState,
      why: isBuy
        ? "Buy aggression is consuming asks faster than they replenish, and price is responding upward."
        : "Sell aggression is consuming bids faster than they replenish, and price is responding downward.",
      evidence,
    };
  }

  if (attackHigh && survival >= 60 && defenseStrong && absScore != null && absScore >= 50 && eff < 55) {
    return {
      state: isBuy ? "SELLERS_DEFENDING" : "BUYERS_DEFENDING",
      passiveState,
      why: isBuy
        ? "Passive asks are holding/replenishing against elevated buy aggression."
        : "Passive bids are holding/replenishing against elevated sell aggression.",
      evidence,
    };
  }

  if (cancelExtreme) {
    return {
      state: isBuy ? "ASK_LIQUIDITY_WITHDRAWING" : "BID_LIQUIDITY_WITHDRAWING",
      passiveState,
      why: isBuy
        ? "Ask cancellations are extreme versus history — offer-side liquidity is pulling."
        : "Bid cancellations are extreme versus history — bid-side liquidity is pulling.",
      evidence,
    };
  }

  if (withHigh) {
    return {
      state: isBuy ? "ASK_LIQUIDITY_WITHDRAWING" : "BID_LIQUIDITY_WITHDRAWING",
      passiveState,
      why: isBuy
        ? "Ask cancellations exceed replenishment while activity remains elevated."
        : "Bid cancellations exceed replenishment while activity remains elevated.",
      evidence,
    };
  }

  if (Math.abs(power - 50) < 12 && Math.abs(eff - 50) < 15 && Math.abs(passiveDefense - 50) < 12) {
    return {
      state: "BALANCED",
      passiveState,
      why: "Attack power, defense power, and price response are near normal — no clear winner.",
      evidence,
    };
  }

  return {
    state: passiveState,
    passiveState,
    why: "No dominant interaction pattern — showing the leading passive-liquidity state.",
    evidence,
  };
}

function fmtShort(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

export class MarketBattleEngine {
  constructor(config) {
    this.config = config;
    this.history = new RollingHistory(280);
    /** @type {Array<{t:number, askDepth:number, bidDepth:number, nearAsk:number, nearBid:number}>} */
    this.depthHist = [];
    this.maxDepthAgeSec = Math.max(...(config.windows || [60]), 2700) + 10;
  }

  clear() {
    this.history.clear();
    this.depthHist = [];
  }

  /**
   * Build buy+sell battle cards for every configured window.
   */
  buildAll({
    windows,
    flowWindows,
    liqWindows,
    askLiquidity,
    bidLiquidity,
    nearAskLiquidity = null,
    nearBidLiquidity = null,
    priceNow,
    priceHistory,
    now,
    bookReady,
    tradesReady,
    staleBook = false,
    walls = null,
  }) {
    const out = {};
    const missingTrades = !tradesReady;
    const missingBook = !bookReady;
    const stale = !!staleBook || missingBook;

    // Snapshot current depth into history for windowed defense averages
    if (bookReady && !staleBook) {
      this.depthHist.push({
        t: now,
        askDepth: askLiquidity || 0,
        bidDepth: bidLiquidity || 0,
        nearAsk: nearAskLiquidity ?? askLiquidity ?? 0,
        nearBid: nearBidLiquidity ?? bidLiquidity ?? 0,
      });
      while (this.depthHist.length && now - this.depthHist[0].t > this.maxDepthAgeSec) {
        this.depthHist.shift();
      }
    }

    const dataQuality = {
      trades: !missingTrades,
      book: !missingBook,
      stale,
    };

    for (const w of windows) {
      const flow = flowWindows[w] || flowWindows[String(w)] || {};
      const liq = liqWindows[w] || liqWindows[String(w)] || {};
      const priceThen = priceAtLookback(priceHistory, now, w) ?? priceNow;

      const askAvg = averageDepthOverWindow(this.depthHist, now, w, "ask");
      const bidAvg = averageDepthOverWindow(this.depthHist, now, w, "bid");

      // Window CVD change = window netDelta (reuse existing flow metric)
      const netDelta = flow.netDelta ?? (flow.aggressiveBuyVolume || 0) - (flow.aggressiveSellVolume || 0);
      const cvdDelta = netDelta;

      const buy = buildBattleCard({
        side: "buy",
        windowSec: w,
        aggressiveVolume: missingTrades ? null : flow.aggressiveBuyVolume || 0,
        opposingAggressiveVolume: missingTrades ? null : flow.aggressiveSellVolume || 0,
        consumed: missingBook || stale ? null : liq.askExec || 0,
        cancelled: missingBook || stale ? null : liq.askCancel || 0,
        replenished: missingBook || stale ? null : liq.askRefill || 0,
        stacked: missingBook || stale ? null : liq.askStack || 0,
        currentLiquidity: missingBook || stale ? null : askLiquidity || 0,
        windowedDepth: askAvg.depth,
        windowedNear: askAvg.near,
        priceNow,
        priceThen,
        history: this.history,
        tradeCount: missingTrades ? null : flow.buyCount || 0,
        largeTradeVolume: missingTrades ? null : flow.largeBuyVolume || 0,
        netDelta: missingTrades ? null : netDelta,
        cvdDelta: missingTrades ? null : cvdDelta,
        wall: walls?.largestAskWall || null,
        now,
        dataQuality,
      });

      const sell = buildBattleCard({
        side: "sell",
        windowSec: w,
        aggressiveVolume: missingTrades ? null : flow.aggressiveSellVolume || 0,
        opposingAggressiveVolume: missingTrades ? null : flow.aggressiveBuyVolume || 0,
        consumed: missingBook || stale ? null : liq.bidExec || 0,
        cancelled: missingBook || stale ? null : liq.bidCancel || 0,
        replenished: missingBook || stale ? null : liq.bidRefill || 0,
        stacked: missingBook || stale ? null : liq.bidStack || 0,
        currentLiquidity: missingBook || stale ? null : bidLiquidity || 0,
        windowedDepth: bidAvg.depth,
        windowedNear: bidAvg.near,
        priceNow,
        priceThen,
        history: this.history,
        tradeCount: missingTrades ? null : flow.sellCount || 0,
        largeTradeVolume: missingTrades ? null : flow.largeSellVolume || 0,
        netDelta: missingTrades ? null : netDelta,
        cvdDelta: missingTrades ? null : cvdDelta,
        wall: walls?.largestBidWall || null,
        now,
        dataQuality,
      });

      out[w] = {
        buy,
        sell,
        UpsideBattleSpread: buy.battleSpread,
        DownsideBattleSpread: sell.battleSpread,
        AggressiveBuyPower: buy.attack.power,
        AggressiveSellPower: sell.attack.power,
        PassiveSellerDefense: buy.defense.power,
        PassiveBuyerDefense: sell.defense.power,
      };
    }
    return out;
  }
}
