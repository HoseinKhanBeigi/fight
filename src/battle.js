/**
 * Market battle engine: ATTACK + DEFENSE + RESPONSE → STATE + WHY.
 * Builds per-window fight cards without replacing the existing feed/liquidity engines.
 */

const EPS = 1e-12;

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

  /** Map percentile → 0–100 contextual power score. */
  powerFromPercentile(p) {
    if (p == null) return 50;
    return score100(p);
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
  stacked, // new stacking (optional)
  currentLiquidity,
  priceNow,
  priceThen,
  history,
  tradeCount = 0,
  largeTradeVolume = 0,
  dataQuality = { trades: true, book: true, stale: false },
}) {
  const isBuy = side === "buy";
  const prefix = isBuy ? "ask" : "bid";
  const attackName = isBuy ? "buy" : "sell";

  const netWithdrawal = Math.max(0, cancelled - replenished);
  const netAddition = Math.max(0, replenished - cancelled);
  const behavioralNetChange = (stacked || 0) + replenished - cancelled - consumed;
  const grossChurn = (stacked || 0) + replenished + cancelled + consumed;
  const churnRatio = safeDiv(grossChurn, currentLiquidity);
  const survivalRaw = clamp01(
    1 -
      0.45 * clamp01(safeDiv(consumed, Math.max(currentLiquidity, consumed))) -
      0.35 * clamp01(safeDiv(netWithdrawal, Math.max(cancelled + replenished, EPS))) +
      0.25 * clamp01(safeDiv(replenished, Math.max(consumed, EPS)))
  );
  const withdrawalRaw = clamp01(safeDiv(netWithdrawal, Math.max(cancelled + replenished, EPS)));

  const moveBps = priceMoveBps(priceNow, priceThen);
  const directionalBps = isBuy ? moveBps : -moveBps; // positive = favorable to aggressor
  const effort = Math.max(aggressiveVolume, EPS);
  // Efficiency: favorable bps per $1M aggression, then squash
  const rawEff = clamp01(safeDiv(Math.max(0, directionalBps), safeDiv(effort, 1_000_000) * 12));
  const inverseEff = 1 - rawEff;

  const consumptionStrength = clamp01(safeDiv(consumed, Math.max(aggressiveVolume, currentLiquidity * 0.05, EPS)));
  const replenishStrength = clamp01(safeDiv(replenished, Math.max(consumed, currentLiquidity * 0.05, EPS)));
  const attackPowerRaw = clamp01(
    0.55 * clamp01(safeDiv(aggressiveVolume, Math.max(currentLiquidity, EPS))) +
      0.25 * consumptionStrength +
      0.2 * clamp01(safeDiv(aggressiveVolume, Math.max(opposingAggressiveVolume, aggressiveVolume, EPS)))
  );

  // Historical context keys
  const kAgg = `${prefix}:${windowSec}:agg`;
  const kCancel = `${prefix}:${windowSec}:cancel`;
  const kRefill = `${prefix}:${windowSec}:refill`;
  const kCons = `${prefix}:${windowSec}:cons`;
  const kChurn = `${prefix}:${windowSec}:churn`;
  const kEff = `${prefix}:${windowSec}:eff`;
  const kWith = `${prefix}:${windowSec}:withdraw`;

  if (history) {
    history.push(kAgg, aggressiveVolume);
    history.push(kCancel, cancelled);
    history.push(kRefill, replenished);
    history.push(kCons, consumed);
    history.push(kChurn, churnRatio);
    history.push(kEff, rawEff);
    history.push(kWith, netWithdrawal);
  }

  const aggPct = history?.percentile(kAgg, aggressiveVolume);
  const cancelPct = history?.percentile(kCancel, cancelled);
  const refillPct = history?.percentile(kRefill, replenished);
  const consPct = history?.percentile(kCons, consumed);
  const churnPct = history?.percentile(kChurn, churnRatio);
  const effPct = history?.percentile(kEff, rawEff);
  const withPct = history?.percentile(kWith, netWithdrawal);

  const power = history ? history.powerFromPercentile(aggPct) : score100(attackPowerRaw);
  const survival = score100(survivalRaw);
  const withdrawal = score100(withdrawalRaw);
  const upOrDownEff = score100(rawEff);
  // Prefer historical efficiency when available
  const efficiency = effPct != null ? history.powerFromPercentile(effPct) : upOrDownEff;

  // Absorption score 0–100 (NOT min of dollars)
  const absorption01 = clamp01(
    0.22 * attackPowerRaw +
      0.18 * consumptionStrength +
      0.22 * replenishStrength +
      0.2 * survivalRaw +
      0.18 * inverseEff
  );
  const absorptionScore = score100(absorption01);

  // Estimated absorbed flow — secondary notional only
  const estimatedAbsorbedFlow =
    aggressiveVolume *
    clamp01(consumptionStrength) *
    clamp01(replenishStrength) *
    clamp01(0.35 + 0.65 * inverseEff);

  const velocity = safeDiv(aggressiveVolume, Math.max(windowSec, 1));

  const missingTrades = dataQuality.trades === false;
  const staleBook = !!dataQuality.stale || dataQuality.book === false;
  const lowConfidence = missingTrades || staleBook || (aggPct == null && aggressiveVolume <= 0);

  const attack = {
    aggressiveVolume: missingTrades ? null : aggressiveVolume,
    power,
    percentile: aggPct == null ? null : Math.round(aggPct * 100),
    percentileBand: history?.band(aggPct) || "UNKNOWN",
    velocity: missingTrades ? null : velocity,
    largeVolume: missingTrades ? null : largeTradeVolume,
    tradeCount: missingTrades ? null : tradeCount,
  };

  const defense = {
    currentLiquidity: staleBook ? null : currentLiquidity,
    consumed: staleBook ? null : consumed,
    cancelled: staleBook ? null : cancelled,
    replenished: staleBook ? null : replenished,
    stacked: staleBook ? null : stacked || 0,
    netWithdrawal: staleBook ? null : netWithdrawal,
    netAddition: staleBook ? null : netAddition,
    behavioralNetChange: staleBook ? null : behavioralNetChange,
    survival: staleBook ? null : survival,
    withdrawal: staleBook ? null : withdrawal,
    churnRatio: staleBook ? null : churnRatio,
    churnLabel: staleBook ? "UNKNOWN" : churnLabel(churnRatio, churnPct),
    cancelPercentile: cancelPct == null ? null : Math.round(cancelPct * 100),
    cancelBand: history?.band(cancelPct) || "UNKNOWN",
    refillPercentile: refillPct == null ? null : Math.round(refillPct * 100),
    refillBand: history?.band(refillPct) || "UNKNOWN",
    consumePercentile: consPct == null ? null : Math.round(consPct * 100),
    consumeBand: history?.band(consPct) || "UNKNOWN",
    withdrawalPercentile: withPct == null ? null : Math.round(withPct * 100),
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
    lowConfidence,
    missingTrades,
    staleBook,
    cancelPct,
    refillPct,
    consPct,
    withPct,
    aggPct,
  });

  return {
    side,
    windowSec,
    attack,
    defense,
    response,
    state,
    passiveState,
    why,
    evidence,
    labels: {
      aggressive: isBuy ? "Aggressive Buy Volume" : "Aggressive Sell Volume",
      consumed: isBuy ? "Ask Liquidity Consumed" : "Bid Liquidity Consumed",
      cancelled: isBuy ? "Ask Cancelled" : "Bid Cancelled",
      replenished: isBuy ? "Ask Replenished" : "Bid Replenished",
      liquidity: isBuy ? "Current Ask Liquidity" : "Current Bid Liquidity",
      absorption: isBuy ? "Seller Absorption" : "Buyer Absorption",
      efficiency: isBuy ? "Upward Price Efficiency" : "Downward Price Efficiency",
    },
  };
}

function classifyBattle({
  isBuy,
  attack,
  defense,
  response,
  lowConfidence,
  missingTrades,
  staleBook,
  cancelPct,
  refillPct,
  consPct,
  withPct,
  aggPct,
}) {
  if (missingTrades || staleBook || lowConfidence) {
    return {
      state: "LOW_CONFIDENCE",
      passiveState: "LOW_CONFIDENCE",
      why: missingTrades
        ? "Trade data unavailable — cannot classify attack or absorption."
        : staleBook
          ? "Order book data is stale or missing — passive defense metrics are unreliable."
          : "Insufficient history or weak signal — classification confidence is low.",
      evidence: [],
    };
  }

  const power = attack.power;
  const survival = defense.survival ?? 50;
  const withdrawal = defense.withdrawal ?? 0;
  const eff = response.efficiency;
  const absScore = response.absorptionScore;
  const churn = defense.churnLabel;
  const depth = defense.currentLiquidity || 0;
  const agg = attack.aggressiveVolume || 0;
  const meaningful = agg > 0 && (defense.consumed > 0 || defense.cancelled > 0 || defense.replenished > 0);

  if (!meaningful && power < 35) {
    return {
      state: "NO_MEANINGFUL_BATTLE",
      passiveState: isBuy ? "ASK_LIQUIDITY_STABLE" : "BID_LIQUIDITY_STABLE",
      why: "Aggression and passive turnover are both too small to call a clear battle.",
      evidence: [
        { k: "Attack power", v: `${power}/100` },
        { k: "Aggressive volume", v: fmtShort(agg) },
      ],
    };
  }

  const cancelExtreme = (cancelPct ?? 0) >= 0.95;
  const cancelHigh = (cancelPct ?? 0) >= 0.8;
  const refillExtreme = (refillPct ?? 0) >= 0.95;
  const consHigh = (consPct ?? 0) >= 0.8 || (defense.consumeBand === "HIGH" || defense.consumeBand === "EXTREME");
  const withHigh = (withPct ?? 0) >= 0.8 || withdrawal >= 60;
  const attackHigh = power >= 65 || (aggPct ?? 0) >= 0.7;
  const attackMod = power >= 45;

  // Passive-only labels
  let passiveState = isBuy ? "ASK_LIQUIDITY_STABLE" : "BID_LIQUIDITY_STABLE";
  if (cancelExtreme) passiveState = isBuy ? "ASK_CANCELLATION_SURGE" : "BID_CANCELLATION_SURGE";
  else if (refillExtreme && !withHigh) passiveState = isBuy ? "ASK_REPLENISHMENT_SURGE" : "BID_REPLENISHMENT_SURGE";
  else if (withHigh) passiveState = isBuy ? "ASK_LIQUIDITY_WITHDRAWING" : "BID_LIQUIDITY_WITHDRAWING";
  else if ((defense.behavioralNetChange || 0) > 0 && (refillPct ?? 0.5) >= 0.55)
    passiveState = isBuy ? "ASK_LIQUIDITY_BUILDING" : "BID_LIQUIDITY_BUILDING";
  else if (consHigh) passiveState = isBuy ? "ASK_CONSUMPTION_HIGH" : "BID_CONSUMPTION_HIGH";
  else if (survival >= 70) passiveState = isBuy ? "ASK_SURVIVING" : "BID_SURVIVING";
  else if (survival <= 40) passiveState = isBuy ? "ASK_DEFENSE_WEAKENING" : "BID_DEFENSE_WEAKENING";

  const evidence = [
    { k: "Attack power", v: `${power}/100` },
    { k: "Cancel percentile", v: cancelPct == null ? "n/a" : `${Math.round(cancelPct * 100)}th` },
    { k: "Replenish percentile", v: refillPct == null ? "n/a" : `${Math.round(refillPct * 100)}th` },
    { k: "Net withdrawal", v: fmtShort(defense.netWithdrawal) },
    { k: "Survival", v: `${survival}/100` },
    { k: isBuy ? "Up efficiency" : "Down efficiency", v: `${eff}/100` },
    { k: isBuy ? "Seller absorption" : "Buyer absorption", v: `${absScore}/100` },
    { k: "Churn", v: churn },
    { k: "Price move", v: `${response.priceMoveBps >= 0 ? "+" : ""}${response.priceMoveBps.toFixed(1)} bps` },
  ];

  // Interaction states (priority)
  if (attackHigh && absScore >= 65 && eff <= 40 && survival >= 55) {
    return {
      state: isBuy ? "SELLER_ABSORPTION" : "BUYER_ABSORPTION",
      passiveState,
      why: isBuy
        ? "Buy aggression is elevated, but asks replenish/survive and upside displacement stays weak."
        : "Sell aggression is elevated, but bids replenish/survive and downside displacement stays weak.",
      evidence,
    };
  }

  if (attackMod && withHigh && depth > 0 && survival <= 45 && eff >= 55) {
    return {
      state: isBuy ? "UPSIDE_LIQUIDITY_VACUUM" : "DOWNSIDE_LIQUIDITY_VACUUM",
      passiveState,
      why: isBuy
        ? "Asks are withdrawing while buy pressure converts into upside — resistance above is thinning."
        : "Bids are withdrawing while sell pressure converts into downside — support below is thinning.",
      evidence,
    };
  }

  if (attackHigh && consHigh && (refillPct ?? 1) < 0.55 && survival <= 45 && eff >= 55) {
    return {
      state: isBuy ? "BUYERS_WINNING" : "SELLERS_WINNING",
      passiveState,
      why: isBuy
        ? "Buy aggression is consuming asks faster than they replenish, and price is responding upward."
        : "Sell aggression is consuming bids faster than they replenish, and price is responding downward.",
      evidence,
    };
  }

  if (attackHigh && survival >= 60 && absScore >= 50 && eff < 55) {
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

  if (Math.abs(power - 50) < 12 && Math.abs(eff - 50) < 15) {
    return {
      state: "BALANCED",
      passiveState,
      why: "Attack power and price response are both near normal — no clear winner.",
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
  }

  clear() {
    this.history.clear();
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
    priceNow,
    priceHistory,
    now,
    bookReady,
    tradesReady,
  }) {
    const out = {};
    const dataQuality = {
      trades: !!tradesReady,
      book: !!bookReady,
      stale: !bookReady,
    };

    for (const w of windows) {
      const flow = flowWindows[w] || {};
      const liq = liqWindows[w] || {};
      const priceThen = priceAtLookback(priceHistory, now, w) ?? priceNow;

      const buy = buildBattleCard({
        side: "buy",
        windowSec: w,
        aggressiveVolume: flow.aggressiveBuyVolume || 0,
        opposingAggressiveVolume: flow.aggressiveSellVolume || 0,
        consumed: liq.askExec || 0,
        cancelled: liq.askCancel || 0,
        replenished: liq.askRefill || 0,
        stacked: liq.askStack || 0,
        currentLiquidity: askLiquidity || 0,
        priceNow,
        priceThen,
        history: this.history,
        dataQuality,
      });

      const sell = buildBattleCard({
        side: "sell",
        windowSec: w,
        aggressiveVolume: flow.aggressiveSellVolume || 0,
        opposingAggressiveVolume: flow.aggressiveBuyVolume || 0,
        consumed: liq.bidExec || 0,
        cancelled: liq.bidCancel || 0,
        replenished: liq.bidRefill || 0,
        stacked: liq.bidStack || 0,
        currentLiquidity: bidLiquidity || 0,
        priceNow,
        priceThen,
        history: this.history,
        dataQuality,
      });

      out[w] = { buy, sell };
    }
    return out;
  }
}
