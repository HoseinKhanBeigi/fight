/**
 * Immutable feature snapshot at timestamp T.
 * Reads live engine OUTPUTS only — does not recompute battle / pre-move scores.
 */

import {
  FEED_STATUS,
  OPTIONAL_EVENT_KEYS,
  OPTIONAL_FUTURES_KEYS,
  PATH_STATES,
  SESSIONS,
} from "./constants.js";
import { CausalNormalizer, clamp, clamp01, finite, freezeDeep, stdev } from "./math.js";
import { getStrategy, strategyFingerprint } from "./strategy.js";
import { scoreSnapshot } from "./scores.js";

function pick(...vals) {
  for (const v of vals) {
    const n = finite(v);
    if (n != null) return n;
  }
  return null;
}

function statusOrNull(v) {
  if (v == null || v === "") return FEED_STATUS.NO_DATA;
  const s = String(v).toUpperCase();
  if (s === "OK" || s === "REAL_ZERO") return FEED_STATUS.OK;
  if (s === "STALE") return FEED_STATUS.STALE;
  if (s === "NO_DATA" || s === "NO_TRADE_DATA" || s === "NO_BOOK_DATA") return FEED_STATUS.NO_DATA;
  if (s === "DEGRADED" || s === "LOW_CONFIDENCE") return FEED_STATUS.DEGRADED;
  return FEED_STATUS.OK;
}

/** UTC crypto sessions (hour of UTC). */
export function sessionFromUnix(tsSec) {
  const d = new Date(tsSec * 1000);
  const hour = d.getUTCHours();
  const dayOfWeek = d.getUTCDay();
  let session = SESSIONS.US;
  if (hour >= 0 && hour < 7) session = SESSIONS.ASIA;
  else if (hour >= 7 && hour < 13) session = SESSIONS.EUROPE;
  else session = SESSIONS.US;
  return { session, hour, dayOfWeek };
}

export function mapEngineState({ battleBuy, battleSell, preMoveState, confidence }) {
  const c = finite(confidence);
  const buy = String(battleBuy || "");
  const sell = String(battleSell || "");
  const pm = String(preMoveState || "");
  if (
    (c != null && c < 35) ||
    buy === "LOW_CONFIDENCE" ||
    sell === "LOW_CONFIDENCE" ||
    pm === "LOW_CONFIDENCE"
  ) {
    return "LOW_CONFIDENCE";
  }
  if (buy === "SELLER_ABSORPTION" || pm === "SELLER_ABSORPTION") return "SELLER_ABSORPTION";
  if (sell === "BUYER_ABSORPTION" || pm === "BUYER_ABSORPTION") return "BUYER_ABSORPTION";
  if (
    buy === "BUYERS_WINNING" ||
    pm === "STRONG_UPSIDE_PRESSURE" ||
    pm === "UPSIDE_MOVE_CONFIRMED"
  ) {
    return "BUYERS_WINNING";
  }
  if (
    sell === "SELLERS_WINNING" ||
    pm === "STRONG_DOWNSIDE_PRESSURE" ||
    pm === "DOWNSIDE_MOVE_CONFIRMED"
  ) {
    return "SELLERS_WINNING";
  }
  if (
    buy === "UPSIDE_LIQUIDITY_VACUUM" ||
    pm === "UPSIDE_LIQUIDITY_VACUUM_FORMING" ||
    pm === "UPSIDE_VACUUM"
  ) {
    return "UPSIDE_VACUUM";
  }
  if (
    sell === "DOWNSIDE_LIQUIDITY_VACUUM" ||
    pm === "DOWNSIDE_LIQUIDITY_VACUUM_FORMING" ||
    pm === "DOWNSIDE_VACUUM"
  ) {
    return "DOWNSIDE_VACUUM";
  }
  if (pm === "COMPRESSION" || pm === "TWO_SIDED_PRESSURE" || buy === "COMPRESSION") {
    return "COMPRESSION";
  }
  if (
    pm === "UPSIDE_PRESSURE_BUILDING" ||
    pm === "MULTI_TIMEFRAME_UP_PRESSURE" ||
    pm === "UPPER_DEFENSE_WEAKENING"
  ) {
    return "UPSIDE_PRESSURE_BUILDING";
  }
  if (
    pm === "DOWNSIDE_PRESSURE_BUILDING" ||
    pm === "MULTI_TIMEFRAME_DOWN_PRESSURE" ||
    pm === "LOWER_DEFENSE_WEAKENING"
  ) {
    return "DOWNSIDE_PRESSURE_BUILDING";
  }
  if (PATH_STATES.includes(pm)) return pm;
  return "BALANCED";
}

function returnsBetween(ticks, t0, lookbackSec) {
  const tStart = t0 - lookbackSec;
  const rets = [];
  let prev = null;
  for (const row of ticks || []) {
    if (row.t < tStart || row.t > t0) continue;
    if (prev && prev > 0 && Number.isFinite(row.price)) {
      rets.push((row.price - prev) / prev);
    }
    prev = row.price;
  }
  return rets;
}

function rangeOver(ticks, t0, lookbackSec) {
  const tStart = t0 - lookbackSec;
  let hi = null;
  let lo = null;
  let first = null;
  let last = null;
  for (const row of ticks || []) {
    if (row.t < tStart || row.t > t0) continue;
    if (!Number.isFinite(row.price)) continue;
    if (first == null) first = row.price;
    last = row.price;
    hi = hi == null ? row.price : Math.max(hi, row.price);
    lo = lo == null ? row.price : Math.min(lo, row.price);
  }
  return { hi, lo, first, last };
}

function minuteRanges(ticks, t0, minutes) {
  const buckets = [];
  for (let i = minutes; i >= 1; i--) {
    const end = t0 - (i - 1) * 60;
    const start = end - 60;
    let hi = null;
    let lo = null;
    let open = null;
    let close = null;
    for (const row of ticks || []) {
      if (row.t <= start || row.t > end) continue;
      if (!Number.isFinite(row.price)) continue;
      if (open == null) open = row.price;
      close = row.price;
      hi = hi == null ? row.price : Math.max(hi, row.price);
      lo = lo == null ? row.price : Math.min(lo, row.price);
    }
    if (hi != null && lo != null && close != null) {
      const prevClose = buckets.length ? buckets[buckets.length - 1].close : open;
      const tr = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
      buckets.push({ hi, lo, close, tr });
    }
  }
  return buckets;
}

export function classifyRegime({ realizedVolPct, rangePct, driftAbs, rangeFrac }) {
  let volatility = "NORMAL";
  if (realizedVolPct != null && realizedVolPct >= 80) volatility = "HIGH_VOLATILITY";
  else if (realizedVolPct != null && realizedVolPct <= 20) volatility = "LOW_VOLATILITY";

  let primary = "RANGE";
  if (rangePct != null && rangePct <= 25) primary = "COMPRESSION";
  else if (rangeFrac > 0 && driftAbs / Math.max(rangeFrac, 1e-12) >= 0.55 && driftAbs >= 0.0015) {
    primary = "TREND";
  }

  const tags = [primary];
  if (volatility !== "NORMAL") tags.push(volatility);
  return { primary, volatility, tags, label: tags.join("+") };
}

function nullOptionals() {
  const out = {};
  for (const k of OPTIONAL_FUTURES_KEYS) out[k] = null;
  for (const k of OPTIONAL_EVENT_KEYS) out[k] = null;
  return out;
}

function pack(rawVal, normVal, extra = {}) {
  return {
    raw: rawVal == null ? null : rawVal,
    normalized: normVal == null ? null : normVal,
    ...extra,
  };
}

/**
 * Extract raw + normalized features from a live monitor snapshot.
 * `norm` is a CausalNormalizer used only for context features (vol, churn, accel).
 */
export function extractFeatures(live, { ticks = [], now, selectedTimeframe = 60, norm = null } = {}) {
  const t = Number.isFinite(now)
    ? now
    : Number.isFinite(live.ts)
      ? live.ts / 1000
      : Date.now() / 1000;
  const pm = live.preMove?.current || {};
  const feat = pm.features || {};
  const rawPm = pm.raw || {};
  const perc = pm.percentiles || {};
  const w = selectedTimeframe;
  const battle = live.battlesByWindow?.[w] || live.battlesByWindow?.[String(w)] || {};
  const flow = live.flowWindows?.[w] || live.flowWindows?.[String(w)] || {};
  const liq = live.liqWindows?.[w] || live.liqWindows?.[String(w)] || {};

  const price = pick(live.price, rawPm.mid, pm.price);
  const upPressure = pick(pm.upPressure, feat.upPressure);
  const downPressure = pick(pm.downPressure, feat.downPressure);
  const buyPow = pick(feat.AggressiveBuyPower, pm.AggressiveBuyPower, battle.buy?.attack?.power);
  const sellPow = pick(feat.AggressiveSellPower, pm.AggressiveSellPower, battle.sell?.attack?.power);
  const askDef = pick(feat.PassiveSellerDefense, pm.PassiveSellerDefense, battle.buy?.defense?.power);
  const bidDef = pick(feat.PassiveBuyerDefense, pm.PassiveBuyerDefense, battle.sell?.defense?.power);
  const askCancel = pick(feat.AskCancellation, pm.breakdown?.upside?.askCancellation);
  const bidCancel = pick(feat.BidCancellation, pm.breakdown?.downside?.bidCancellation);
  const askRefill = pick(feat.AskReplenishment, pm.breakdown?.upside?.askReplenishment);
  const bidRefill = pick(feat.BidReplenishment, pm.breakdown?.downside?.bidReplenishment);
  const askCons = pick(feat.AskConsumption, pm.breakdown?.upside?.askConsumption);
  const bidCons = pick(feat.BidConsumption, pm.breakdown?.downside?.bidConsumption);
  const askSurv = pick(feat.AskSurvival, pm.breakdown?.upside?.askSurvival);
  const bidSurv = pick(feat.BidSurvival, pm.breakdown?.downside?.bidSurvival);
  const upSpread = pick(pm.UpsideBattleSpread, feat.UpsideBattleSpread, battle.buy?.battleSpread);
  const downSpread = pick(pm.DownsideBattleSpread, feat.DownsideBattleSpread, battle.sell?.battleSpread);
  const confidence = pick(pm.confidence, live.preMove?.current?.confidence);

  const nearAsk = pick(feat.NearAskDepth, rawPm.nearAskCurrent);
  const nearBid = pick(feat.NearBidDepth, rawPm.nearBidCurrent);
  const bookImb = pick(rawPm.bookImbalance, live.bookShape?.bookImb);
  const upVel = pick(pm.upVelocity);
  const downVel = pick(pm.downVelocity);
  const upAcc = pick(pm.upAcceleration);
  const downAcc = pick(pm.downAcceleration);
  const askChurn = pick(feat.AskChurn);
  const bidChurn = pick(feat.BidChurn);

  const buyVol = pick(rawPm.buyVol, flow.aggressiveBuyVolume);
  const sellVol = pick(rawPm.sellVol, flow.aggressiveSellVolume);
  const buySellDeltaRaw = buyVol == null || sellVol == null ? null : buyVol - sellVol;

  const look15 = rangeOver(ticks, t, 900);
  const last15mReturn =
    look15.first > 0 && look15.last != null ? (look15.last - look15.first) / look15.first : null;
  const rangeFrac =
    price > 0 && look15.hi != null && look15.lo != null ? (look15.hi - look15.lo) / price : null;
  const rets15 = returnsBetween(ticks, t, 900);
  const rets60 = returnsBetween(ticks, t, 60);
  const realizedVol = stdev(rets15);
  const shortVol = stdev(rets60);
  const bars = minuteRanges(ticks, t, 14);
  const atr =
    bars.length >= 5 ? bars.reduce((s, b) => s + b.tr, 0) / bars.length : null;
  const atrNorm = atr != null && price > 0 ? atr / price : null;
  const driftAbs = last15mReturn == null ? 0 : Math.abs(last15mReturn);

  const n = (key, value) => (norm ? norm.observe(key, value) : { power: null, z: null, robustZ: null, percentile100: null });

  const rvN = n("realizedVolatility", realizedVol);
  const svN = n("shortTermVolatility", shortVol);
  const atrN = n("ATRNormalized", atrNorm);
  const rngN = n("rangePercentile", rangeFrac);
  const upAccN = n("UpPressureAcceleration", upAcc);
  const downAccN = n("DownPressureAcceleration", downAcc);
  const askChurnN = n("AskChurn", askChurn);
  const bidChurnN = n("BidChurn", bidChurn);
  const imbN = n("BookImbalance", bookImb);
  const deltaN = n("BuySellDelta", buySellDeltaRaw);
  const upVelN = n("UpPressureVelocity", upVel);
  const downVelN = n("DownPressureVelocity", downVel);
  const nearAskN = n("NearAskDepthRaw", pick(rawPm.nearAskCurrent, rawPm.nearAskWindowed));
  const nearBidN = n("NearBidDepthRaw", pick(rawPm.nearBidCurrent, rawPm.nearBidWindowed));

  const rangePercentile = rngN.percentile100;
  const regime = classifyRegime({
    realizedVolPct: rvN.percentile100,
    rangePct: rangePercentile,
    driftAbs,
    rangeFrac: rangeFrac || 0,
  });

  const askCancelRaw = pick(rawPm.askCancel, liq.askCancel);
  const bidCancelRaw = pick(rawPm.bidCancel, liq.bidCancel);
  const askRefillRaw = pick(rawPm.askRefill, liq.askRefill);
  const bidRefillRaw = pick(rawPm.bidRefill, liq.bidRefill);
  const askExecRaw = pick(rawPm.askExec, liq.askExec);
  const bidExecRaw = pick(rawPm.bidExec, liq.bidExec);

  const nearAskNorm = pick(feat.NearAskDepth) ?? nearAskN.power;
  const nearBidNorm = pick(feat.NearBidDepth) ?? nearBidN.power;
  const bookImbNorm =
    imbN.power != null
      ? imbN.power
      : bookImb == null
        ? null
        : Math.round(clamp01((bookImb + 1) / 2) * 100);
  const upCtx =
    nearBidNorm == null && nearAskNorm == null
      ? null
      : ((nearBidNorm ?? 50) + (100 - (nearAskNorm ?? 50))) / 2;
  const downCtx =
    nearBidNorm == null && nearAskNorm == null
      ? null
      : ((nearAskNorm ?? 50) + (100 - (nearBidNorm ?? 50))) / 2;

  const pct100 = (p) => (p == null ? null : Math.round(clamp01(p) * 100));

  const raw = {
    UpPressure: upPressure,
    DownPressure: downPressure,
    AggressiveBuyPower: pick(rawPm.buyVol, buyVol),
    AggressiveSellPower: pick(rawPm.sellVol, sellVol),
    PassiveSellerDefense: askDef,
    PassiveBuyerDefense: bidDef,
    AskCancellation: askCancelRaw,
    BidCancellation: bidCancelRaw,
    AskReplenishment: askRefillRaw,
    BidReplenishment: bidRefillRaw,
    AskConsumption: askExecRaw,
    BidConsumption: bidExecRaw,
    AskSurvival: askSurv,
    BidSurvival: bidSurv,
    UpsideBattleSpread: upSpread,
    DownsideBattleSpread: downSpread,
    Confidence: confidence,
    realizedVolatility: realizedVol,
    shortTermVolatility: shortVol,
    ATRNormalized: atrNorm,
    rangePercentile: rangeFrac,
    NearAskDepth: pick(rawPm.nearAskCurrent, rawPm.nearAskWindowed),
    NearBidDepth: pick(rawPm.nearBidCurrent, rawPm.nearBidWindowed),
    BookImbalance: bookImb,
    UpPressureVelocity: upVel,
    DownPressureVelocity: downVel,
    UpPressureAcceleration: upAcc,
    DownPressureAcceleration: downAcc,
    AskChurn: askChurn,
    BidChurn: bidChurn,
    UpsideBookContext: upCtx,
    DownsideBookContext: downCtx,
    BuySellDelta: buySellDeltaRaw,
    last15mReturn,
    ...nullOptionals(),
  };

  const normalized = {
    UpPressure: upPressure,
    DownPressure: downPressure,
    AggressiveBuyPower: buyPow,
    AggressiveSellPower: sellPow,
    PassiveSellerDefense: askDef,
    PassiveBuyerDefense: bidDef,
    AskCancellation: askCancel ?? pct100(perc.AskCancellation),
    BidCancellation: bidCancel ?? pct100(perc.BidCancellation),
    AskReplenishment: askRefill ?? pct100(perc.AskReplenishment),
    BidReplenishment: bidRefill ?? pct100(perc.BidReplenishment),
    AskConsumption: askCons,
    BidConsumption: bidCons,
    AskSurvival: askSurv,
    BidSurvival: bidSurv,
    UpsideBattleSpread: upSpread == null ? null : clamp(50 + upSpread / 2, 0, 100),
    DownsideBattleSpread: downSpread == null ? null : clamp(50 + downSpread / 2, 0, 100),
    Confidence: confidence,
    realizedVolatility: rvN.power,
    shortTermVolatility: svN.power,
    ATRNormalized: atrN.power,
    rangePercentile: rangePercentile,
    NearAskDepth: nearAskNorm,
    NearBidDepth: nearBidNorm,
    BookImbalance: bookImbNorm,
    UpPressureVelocity: upVelN.power ?? (upVel == null ? null : clamp(50 + upVel, 0, 100)),
    DownPressureVelocity: downVelN.power ?? (downVel == null ? null : clamp(50 + downVel, 0, 100)),
    UpPressureAcceleration: upAccN.power ?? (upAcc == null ? null : clamp(50 + upAcc, 0, 100)),
    DownPressureAcceleration: downAccN.power ?? (downAcc == null ? null : clamp(50 + downAcc, 0, 100)),
    AskChurn: askChurnN.power ?? askChurn,
    BidChurn: bidChurnN.power ?? bidChurn,
    UpsideBookContext: upCtx,
    DownsideBookContext: downCtx,
    BuySellDelta: deltaN.power,
    last15mReturn,
    ...nullOptionals(),
  };

  const normalization = {
    realizedVolatility: rvN,
    shortTermVolatility: svN,
    ATRNormalized: atrN,
    rangePercentile: rngN,
    UpPressureAcceleration: upAccN,
    DownPressureAcceleration: downAccN,
    BookImbalance: imbN,
    BuySellDelta: deltaN,
  };

  return { raw, normalized, normalization, regime, last15mReturn, price };
}

export function feedQuality(live, extra = {}) {
  const pmq = live.preMove?.current?.dataQuality || {};
  const trades = statusOrNull(pmq.trades || (extra.tradesReady === false ? "NO_DATA" : extra.tradesReady ? "OK" : null));
  const book = extra.staleBook
    ? FEED_STATUS.STALE
    : statusOrNull(pmq.book || (extra.bookReady === false ? "NO_DATA" : extra.bookReady ? "OK" : null));
  const lastTradeAge = finite(extra.lastTradeAge);
  const lastBookAge = finite(extra.lastBookAge);
  let sequence = FEED_STATUS.OK;
  if (trades === FEED_STATUS.NO_DATA || book === FEED_STATUS.NO_DATA) sequence = FEED_STATUS.NO_DATA;
  else if (book === FEED_STATUS.STALE || trades === FEED_STATUS.STALE) sequence = FEED_STATUS.STALE;
  else if ((lastBookAge != null && lastBookAge > 2) || (lastTradeAge != null && lastTradeAge > 8)) {
    sequence = FEED_STATUS.DEGRADED;
  }
  let recon = FEED_STATUS.OK;
  const conf = finite(live.preMove?.current?.confidence);
  if (conf != null && conf < 35) recon = FEED_STATUS.DEGRADED;
  const latency =
    lastBookAge != null || lastTradeAge != null
      ? Math.round(Math.max(lastBookAge || 0, lastTradeAge || 0) * 1000)
      : null;
  return {
    TradeFeedStatus: trades,
    BookFeedStatus: book,
    SequenceIntegrity: sequence,
    ReconciliationQuality: recon,
    Latency: latency,
    Confidence: conf,
  };
}

let seq = 0;

export function buildSnapshot(live, ctx = {}) {
  const strategy = ctx.strategy || getStrategy(ctx.strategyVersion);
  const t = Number.isFinite(ctx.now)
    ? ctx.now
    : Number.isFinite(live.ts)
      ? live.ts / 1000
      : Date.now() / 1000;
  const selectedTimeframe = ctx.selectedTimeframe ?? 60;
  const extracted = extractFeatures(live, {
    ticks: ctx.ticks,
    now: t,
    selectedTimeframe,
    norm: ctx.norm,
  });
  const state = mapEngineState({
    battleBuy: live.battlesByWindow?.[selectedTimeframe]?.buy?.state,
    battleSell: live.battlesByWindow?.[selectedTimeframe]?.sell?.state,
    preMoveState: live.preMove?.current?.state,
    confidence: extracted.normalized.Confidence,
  });
  seq += 1;
  const id = `fs_${Math.round(t * 1000)}_${seq}`;
  const clock = sessionFromUnix(t);
  const scored = scoreSnapshot(extracted.normalized, { id, timestamp: t, last15mReturn: extracted.last15mReturn }, strategy);
  const quality = feedQuality(live, ctx);

  const record = {
    id,
    featureSnapshotId: id,
    timestamp: t,
    timestampMs: Math.round(t * 1000),
    symbol: String(live.symbol || ctx.symbol || "").toUpperCase(),
    exchange: ctx.exchange || "BINANCE",
    marketType: ctx.marketType || "USDM_FUTURES",
    price: extracted.price,
    selectedTimeframe,
    strategyVersion: strategy.version,
    strategyFingerprint: strategyFingerprint(strategy),
    features: freezeDeep({
      raw: extracted.raw,
      normalized: extracted.normalized,
      normalization: extracted.normalization,
    }),
    context: freezeDeep({
      regime: extracted.regime,
      ...clock,
      last15mReturn: extracted.last15mReturn,
    }),
    prediction: freezeDeep({
      upsideScore: scored.full.upsideScore,
      downsideScore: scored.full.downsideScore,
      directionalScore: scored.full.directionalScore,
      confidence: scored.full.confidence,
      confidenceFactor: scored.full.confidenceFactor,
      finalDirectionalStrength: scored.full.finalDirectionalStrength,
      state,
      label: scored.full.prediction,
      models: Object.fromEntries(
        Object.entries(scored.models).map(([k, v]) => [
          k,
          { prediction: v.prediction, directionalScore: v.directionalScore },
        ])
      ),
    }),
    dataQuality: freezeDeep(quality),
    outcome: null,
    mode: ctx.mode || "FORWARD",
  };
  return record;
}

export { pack };
