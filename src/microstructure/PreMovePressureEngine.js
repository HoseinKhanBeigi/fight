/**
 * PRE-MOVE PRESSURE ENGINE
 *
 * Book preparation + attack + defense weakening + consumption
 * → pre-move pressure (at T only)
 * → price response / confirmation (after T)
 *
 * Does not use future returns, post-move absorption, or price displacement
 * as inputs to the pre-move score.
 */

import { combineWeighted, invertScore, score100, clamp, clamp01, safeDiv, EPS } from "./math.js";
import { PressureNormalizationEngine } from "./PressureNormalizationEngine.js";
import { BookPreparationEngine } from "./BookPreparationEngine.js";
import { DefenseWeakeningEngine } from "./DefenseWeakeningEngine.js";
import { PressureAccelerationEngine, pressureAt } from "./PressureAccelerationEngine.js";
import { PressurePersistenceEngine } from "./PressurePersistenceEngine.js";
import { PressureStateEngine, PRE_MOVE_STATES, buildWhy } from "./PressureStateEngine.js";
import { PriceResponseEngine } from "./PriceResponseEngine.js";
import { PreMoveBacktest } from "./PreMoveBacktest.js";
import { CONFIG, PRE_MOVE_WEIGHTS } from "../config.js";

function survivalRaw(consumed, cancelled, replenished, currentLiquidity) {
  const netWithdrawal = Math.max(0, cancelled - replenished);
  return clamp01(
    1 -
      0.45 * clamp01(safeDiv(consumed, Math.max(currentLiquidity, consumed, EPS))) -
      0.35 * clamp01(safeDiv(netWithdrawal, Math.max(cancelled + replenished, EPS))) +
      0.25 * clamp01(safeDiv(replenished, Math.max(consumed, EPS)))
  );
}

function withdrawalRaw(cancelled, replenished) {
  const net = Math.max(0, cancelled - replenished);
  return clamp01(safeDiv(net, Math.max(cancelled + replenished, EPS)));
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  let mu = 0;
  for (const v of arr) mu += v;
  mu /= arr.length;
  let s = 0;
  for (const v of arr) {
    const d = v - mu;
    s += d * d;
  }
  return Math.sqrt(s / (arr.length - 1));
}

function depthSnapshot(book, nearN, depthN) {
  const asks = book.nearLevelsList("ask", depthN);
  const bids = book.nearLevelsList("bid", depthN);
  const askDepth = asks.reduce((s, l) => s + l.quantity, 0);
  const bidDepth = bids.reduce((s, l) => s + l.quantity, 0);
  const nearAsk = asks.slice(0, nearN).reduce((s, l) => s + l.quantity, 0);
  const nearBid = bids.slice(0, nearN).reduce((s, l) => s + l.quantity, 0);
  const askConc = askDepth > 0 ? nearAsk / askDepth : 0;
  const bidConc = bidDepth > 0 ? nearBid / bidDepth : 0;
  return {
    askDepth,
    bidDepth,
    nearAsk,
    nearBid,
    askConc,
    bidConc,
    bookImbalance: safeDiv(bidDepth - askDepth, bidDepth + askDepth),
  };
}

function wallApproachScore(wall, mid, tick, now) {
  if (!wall || !wall.active || !Number.isFinite(mid) || !tick) return 0;
  const dist = Math.abs(wall.price - mid) / Math.max(tick, EPS);
  const proximity = clamp01(1 - dist / 12);
  if (proximity <= 0) return 0;
  const pulled = wall.status === "WALL_PULLED" ? 1 : 0;
  const cancel = clamp01(wall.cancelRatio || 0);
  const dep = clamp01(wall.depletionRatio || 0);
  const ageOk = (now - wall.createdAt) * 1000 >= 200;
  return score100((0.4 * cancel + 0.3 * dep + 0.3 * pulled) * proximity * (ageOk ? 1 : 0.5));
}

function wallPersistenceRaw(wall, now) {
  if (!wall || !wall.active) return 0;
  const lifeSec = Math.max(0, now - (wall.createdAt || now));
  const lifeScore = clamp01(lifeSec / 30);
  const sizeHold = clamp01(safeDiv(wall.currentSize || 0, Math.max(wall.initialSize || 0, EPS)));
  const cancelPenalty = clamp01(wall.cancelRatio || 0);
  const depPenalty = clamp01(wall.depletionRatio || 0);
  return clamp01(0.45 * lifeScore + 0.35 * sizeHold + 0.2 * (1 - Math.max(cancelPenalty, depPenalty)));
}

function averageDepthOverWindow(depthHist, now, windowSec) {
  if (!depthHist?.length) {
    return { askDepth: null, bidDepth: null, nearAsk: null, nearBid: null, samples: 0 };
  }
  const t0 = now - windowSec;
  const askD = [];
  const bidD = [];
  const nearA = [];
  const nearB = [];
  for (const row of depthHist) {
    if (row.t < t0 || row.t > now) continue;
    if (Number.isFinite(row.askDepth)) askD.push(row.askDepth);
    if (Number.isFinite(row.bidDepth)) bidD.push(row.bidDepth);
    if (Number.isFinite(row.nearAsk)) nearA.push(row.nearAsk);
    if (Number.isFinite(row.nearBid)) nearB.push(row.nearBid);
  }
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  return {
    askDepth: mean(askD),
    bidDepth: mean(bidD),
    nearAsk: mean(nearA),
    nearBid: mean(nearB),
    samples: askD.length,
  };
}

export class PreMovePressureEngine {
  constructor(config = CONFIG) {
    const pm = { ...CONFIG.preMove, ...(config.preMove || {}) };
    this.config = pm;
    this.windows = [...(pm.windows || [5, 10, 30, 60, 300, 900])];
    this.primaryWindow = pm.primaryWindow ?? 10;
    this.weights = pm.weights || PRE_MOVE_WEIGHTS;
    this.norm = new PressureNormalizationEngine({ maxSamples: 480, minSamples: 8 });
    this.bookPrep = new BookPreparationEngine(this.weights.bookPrep);
    this.defense = new DefenseWeakeningEngine(this.weights.defenseWeaken);
    this.accel = new PressureAccelerationEngine(pm.velocityWindows || [5, 10, 30, 60, 300]);
    this.persist = new PressurePersistenceEngine(pm.persistence);
    this.stateEngine = new PressureStateEngine(pm.hysteresis);
    this.response = new PriceResponseEngine({ minHorizonSec: 5, confirmHorizonSec: 30 });
    this.backtest = new PreMoveBacktest({
      horizons: pm.forwardHorizons || [1, 5, 10, 30, 60, 300],
    });
    /** @type {Array<object>} */
    this.history = [];
    /** @type {Record<number, Array<{t:number, up:number, down:number}>>} */
    this.windowHistory = {};
    /** @type {Array<{t:number, mid:number, nearAsk:number, nearBid:number, askDepth:number, bidDepth:number}>} */
    this.depthHist = [];
    this.prevFeatures = {};
    this.prevCard = null;
  }

  clear() {
    this.norm.clear();
    this.stateEngine.clear();
    this.response.clear();
    this.backtest.clear();
    this.history = [];
    this.windowHistory = {};
    this.depthHist = [];
    this.prevFeatures = {};
    this.prevCard = null;
  }

  /**
   * Build the full pre-move payload from information available at `now`.
   * @param {object} ctx
   */
  snapshot(ctx) {
    const now = ctx.now;
    const cfg = this.config;
    const depth = depthSnapshot(ctx.book, cfg.nearTouchLevels ?? 3, cfg.depthLevels ?? 20);
    this.depthHist.push({
      t: now,
      mid: ctx.priceNow,
      nearAsk: depth.nearAsk,
      nearBid: depth.nearBid,
      askDepth: depth.askDepth,
      bidDepth: depth.bidDepth,
    });
    const maxAge = Math.max(...this.windows, 900) + 10;
    while (this.depthHist.length && now - this.depthHist[0].t > maxAge) this.depthHist.shift();

    const regime = this._regime(ctx.priceHistory, now);
    const approach = this._approach(now, ctx.priceNow, ctx.liqWindows);
    const tradesReady = !!ctx.tradesReady;
    const bookReady = !!ctx.bookReady;
    const staleBook = !!ctx.staleBook || !bookReady;

    /** @type {Record<number, object>} */
    const byWindow = {};
    for (const w of this.windows) {
      byWindow[w] = this._scoreWindow({
        windowSec: w,
        now,
        regime,
        depth,
        approach,
        flow: ctx.flowWindows[w] || ctx.flowWindows[String(w)] || {},
        liq: ctx.liqWindows[w] || ctx.liqWindows[String(w)] || {},
        walls: ctx.walls,
        tick: ctx.tickSize,
        priceNow: ctx.priceNow,
        tradesReady,
        bookReady,
        staleBook,
      });
    }

    const primary = byWindow[this.primaryWindow] || byWindow[10] || byWindow[60];
    const alignment = this._alignment(byWindow);
    const confidence = this._confidence(ctx, primary);

    const candidate = this.stateEngine.candidate({
      up: primary.upPressure,
      down: primary.downPressure,
      imbalance: primary.pressureImbalance,
      upTrend: primary.upTrend,
      downTrend: primary.downTrend,
      upAcc: primary.upAcceleration,
      downAcc: primary.downAcceleration,
      upPers: primary.upPersistence,
      downPers: primary.downPersistence,
      askDefense: primary.askDefenseWeakening,
      bidDefense: primary.bidDefenseWeakening,
      upAttack: primary.upsideAttackScore,
      downAttack: primary.downsideAttackScore,
      upBook: primary.upsideBookPreparation,
      downBook: primary.downsideBookPreparation,
      alignmentLabel: alignment.label,
      confidence,
    });

    // Overlay multi-TF alignment when it is the dominant story
    let rawState = candidate;
    if (
      alignment.label === "MULTI_TIMEFRAME_UP_PRESSURE" &&
      primary.upPressure >= 58 &&
      candidate !== PRE_MOVE_STATES.TRANSIENT_SPIKE &&
      candidate !== PRE_MOVE_STATES.LOW_CONFIDENCE
    ) {
      if (candidate !== PRE_MOVE_STATES.STRONG_UPSIDE_PRESSURE) {
        rawState = PRE_MOVE_STATES.MULTI_TIMEFRAME_UP_PRESSURE;
      }
    } else if (
      alignment.label === "MULTI_TIMEFRAME_DOWN_PRESSURE" &&
      primary.downPressure >= 58 &&
      candidate !== PRE_MOVE_STATES.TRANSIENT_SPIKE &&
      candidate !== PRE_MOVE_STATES.LOW_CONFIDENCE
    ) {
      if (candidate !== PRE_MOVE_STATES.STRONG_DOWNSIDE_PRESSURE) {
        rawState = PRE_MOVE_STATES.MULTI_TIMEFRAME_DOWN_PRESSURE;
      }
    }

    const state = this.stateEngine.classify(now * 1000, rawState, confidence);

    const why = buildWhy(state, {
      up: primary.upPressure,
      down: primary.downPressure,
      upPrev: this.prevCard?.upPressure,
      downPrev: this.prevCard?.downPressure,
      features: primary.features,
      prevFeatures: this.prevFeatures,
      contribUp: primary.upContributions,
      contribDown: primary.downContributions,
      upPers: { ...primary.upPersistence, threshold: this.persist.threshold },
      downPers: { ...primary.downPersistence, threshold: this.persist.threshold },
      askDefense: primary.askDefenseWeakening,
      bidDefense: primary.bidDefenseWeakening,
      upAttack: primary.upsideAttackScore,
      downAttack: primary.downsideAttackScore,
      upBook: primary.upsideBookPreparation,
      downBook: primary.downsideBookPreparation,
      percentiles: primary.percentiles,
      confidence,
    });

    const card = {
      ...primary,
      state,
      confidence: Math.round(confidence),
      confidenceLabel:
        confidence < 35 ? "LOW_CONFIDENCE" : confidence < 60 ? "MODERATE" : "HEALTHY",
      alignment,
      why,
      regime,
    };

    const histPoint = {
      t: now,
      up: primary.upPressure,
      down: primary.downPressure,
      imb: primary.pressureImbalance,
      vel: primary.upVelocity,
      acc: primary.upAcceleration,
      pers: primary.upPersistence.persistence,
      bookPrepUp: primary.upsideBookPreparation,
      bookPrepDown: primary.downsideBookPreparation,
      attackUp: primary.upsideAttackScore,
      attackDown: primary.downsideAttackScore,
      defAsk: primary.askDefenseWeakening,
      defBid: primary.bidDefenseWeakening,
      conf: Math.round(confidence),
      state,
      price: ctx.priceNow,
    };
    this.history.push(histPoint);
    while (this.history.length > (cfg.historyMaxPoints || 4200)) this.history.shift();

    this.response.observePreMove({
      t: now,
      price: ctx.priceNow,
      state,
      up: primary.upPressure,
      down: primary.downPressure,
      imbalance: primary.pressureImbalance,
      askSurvival: primary.features.AskSurvival,
      bidSurvival: primary.features.BidSurvival,
      askReplenish: primary.features.AskReplenishment,
      bidReplenish: primary.features.BidReplenishment,
      askDefense: primary.askDefenseWeakening,
      bidDefense: primary.bidDefenseWeakening,
    });

    const confirmation = this.response.evaluate({
      now,
      priceNow: ctx.priceNow,
      askSurvival: primary.features.AskSurvival,
      bidSurvival: primary.features.BidSurvival,
      askReplenish: primary.features.AskReplenishment,
      bidReplenish: primary.features.BidReplenishment,
    });

    this.backtest.pushSnapshot({
      t: now,
      price: ctx.priceNow,
      state,
      up: primary.upPressure,
      down: primary.downPressure,
      imbalance: primary.pressureImbalance,
      confidence,
    });
    this.backtest.tick(now, ctx.priceNow);

    this.prevFeatures = { ...primary.features };
    this.prevCard = card;

    const spark = this.history.slice(-120).map((h) => ({
      t: h.t,
      up: h.up,
      down: h.down,
      imb: h.imb,
      state: h.state,
    }));

    return {
      primaryWindow: this.primaryWindow,
      windows: this.windows,
      current: card,
      byWindow: Object.fromEntries(
        Object.entries(byWindow).map(([w, v]) => [
          w,
          {
            upPressure: v.upPressure,
            downPressure: v.downPressure,
            pressureImbalance: v.pressureImbalance,
            normalizedImbalance: v.normalizedImbalance,
            upTrend: v.upTrend,
            downTrend: v.downTrend,
            upVelocity: v.upVelocity,
            downVelocity: v.downVelocity,
            upAcceleration: v.upAcceleration,
            upsideBookPreparation: v.upsideBookPreparation,
            downsideBookPreparation: v.downsideBookPreparation,
            upsideAttackScore: v.upsideAttackScore,
            downsideAttackScore: v.downsideAttackScore,
            AggressiveBuyPower: v.AggressiveBuyPower,
            AggressiveSellPower: v.AggressiveSellPower,
            PassiveSellerDefense: v.PassiveSellerDefense,
            PassiveBuyerDefense: v.PassiveBuyerDefense,
            UpsideBattleSpread: v.UpsideBattleSpread,
            DownsideBattleSpread: v.DownsideBattleSpread,
            askDefenseWeakening: v.askDefenseWeakening,
            bidDefenseWeakening: v.bidDefenseWeakening,
            depthSource: v.depthSource,
            dataQuality: v.dataQuality,
          },
        ])
      ),
      alignment,
      confirmation,
      history: spark,
      backtest: this.backtest.summary(),
      calibration: {
        window: this.primaryWindow,
        raw: primary.raw,
        normalized: primary.features,
        percentiles: primary.percentiles,
        weights: {
          up: this.weights.up,
          down: this.weights.down,
        },
        contributions: {
          up: primary.upContributions,
          down: primary.downContributions,
        },
        upPressure: primary.upPressure,
        downPressure: primary.downPressure,
        state,
        confidence: Math.round(confidence),
        regime,
      },
    };
  }

  _scoreWindow({
    windowSec,
    now,
    regime,
    depth,
    approach,
    flow,
    liq,
    walls,
    tick,
    priceNow,
    tradesReady = true,
    bookReady = true,
    staleBook = false,
  }) {
    const missingTrades = !tradesReady;
    const missingBook = !bookReady;
    const stale = !!staleBook || missingBook;

    const buyVol = missingTrades ? null : flow.aggressiveBuyVolume || 0;
    const sellVol = missingTrades ? null : flow.aggressiveSellVolume || 0;
    const tot = (buyVol || 0) + (sellVol || 0);
    const buyVel = missingTrades ? null : safeDiv(buyVol, windowSec);
    const sellVel = missingTrades ? null : safeDiv(sellVol, windowSec);
    const buyImb = missingTrades ? null : tot > 0 ? Math.max(0, (buyVol - sellVol) / tot) : 0;
    const sellImb = missingTrades ? null : tot > 0 ? Math.max(0, (sellVol - buyVol) / tot) : 0;
    const buyCount = missingTrades ? null : flow.buyCount || 0;
    const sellCount = missingTrades ? null : flow.sellCount || 0;
    const buyIntensity = missingTrades ? null : safeDiv(buyCount, windowSec);
    const sellIntensity = missingTrades ? null : safeDiv(sellCount, windowSec);
    const largeBuy = missingTrades ? null : safeDiv(flow.largeBuyVolume || 0, Math.max(buyVol || 0, EPS));
    const largeSell = missingTrades ? null : safeDiv(flow.largeSellVolume || 0, Math.max(sellVol || 0, EPS));
    const netDelta = missingTrades
      ? null
      : flow.netDelta ?? (buyVol || 0) - (sellVol || 0);
    const buyDelta = missingTrades ? null : Math.max(0, netDelta || 0);
    const sellDelta = missingTrades ? null : Math.max(0, -(netDelta || 0));
    // Window CVD contribution reuses netDelta (existing flow metric)
    const buyCvd = buyDelta;
    const sellCvd = sellDelta;

    const askCancel = missingBook || stale ? null : liq.askCancel || 0;
    const bidCancel = missingBook || stale ? null : liq.bidCancel || 0;
    const askRefill = missingBook || stale ? null : liq.askRefill || 0;
    const bidRefill = missingBook || stale ? null : liq.bidRefill || 0;
    const askExec = missingBook || stale ? null : liq.askExec || 0;
    const bidExec = missingBook || stale ? null : liq.bidExec || 0;
    const askStack = missingBook || stale ? null : liq.askStack || 0;
    const bidStack = missingBook || stale ? null : liq.bidStack || 0;

    const windowed = averageDepthOverWindow(this.depthHist, now, windowSec);
    const askDepthWin = windowed.askDepth;
    const bidDepthWin = windowed.bidDepth;
    const nearAskWin = windowed.nearAsk;
    const nearBidWin = windowed.nearBid;
    const askDepthForDef =
      missingBook || stale ? null : Number.isFinite(askDepthWin) ? askDepthWin : depth.askDepth;
    const bidDepthForDef =
      missingBook || stale ? null : Number.isFinite(bidDepthWin) ? bidDepthWin : depth.bidDepth;
    const nearAskForDef =
      missingBook || stale ? null : Number.isFinite(nearAskWin) ? nearAskWin : depth.nearAsk;
    const nearBidForDef =
      missingBook || stale ? null : Number.isFinite(nearBidWin) ? nearBidWin : depth.nearBid;
    const askDepthSource = Number.isFinite(askDepthWin) ? "WINDOWED_DEPTH" : "CURRENT_DEPTH";
    const bidDepthSource = Number.isFinite(bidDepthWin) ? "WINDOWED_DEPTH" : "CURRENT_DEPTH";

    const askSurv =
      askDepthForDef == null
        ? null
        : survivalRaw(askExec || 0, askCancel || 0, askRefill || 0, askDepthForDef);
    const bidSurv =
      bidDepthForDef == null
        ? null
        : survivalRaw(bidExec || 0, bidCancel || 0, bidRefill || 0, bidDepthForDef);
    const askWith = askCancel == null ? null : withdrawalRaw(askCancel, askRefill || 0);
    const bidWith = bidCancel == null ? null : withdrawalRaw(bidCancel, bidRefill || 0);
    const askChurn =
      askDepthForDef == null
        ? null
        : safeDiv((askStack || 0) + (askRefill || 0) + (askCancel || 0) + (askExec || 0), askDepthForDef);
    const bidChurn =
      bidDepthForDef == null
        ? null
        : safeDiv((bidStack || 0) + (bidRefill || 0) + (bidCancel || 0) + (bidExec || 0), bidDepthForDef);
    const askUnreplaced =
      askExec == null ? null : clamp01(safeDiv(askExec, Math.max(askExec + (askRefill || 0), EPS)));
    const bidUnreplaced =
      bidExec == null ? null : clamp01(safeDiv(bidExec, Math.max(bidExec + (bidRefill || 0), EPS)));

    const mid = priceNow;
    const askWall = wallApproachScore(walls?.largestAskWall, mid, tick, now);
    const bidWall = wallApproachScore(walls?.largestBidWall, mid, tick, now);
    const askPersist = missingBook || stale ? null : wallPersistenceRaw(walls?.largestAskWall, now);
    const bidPersist = missingBook || stale ? null : wallPersistenceRaw(walls?.largestBidWall, now);
    const askWeakenRaw =
      askDepthForDef == null
        ? null
        : clamp01(
            0.35 * clamp01(safeDiv(askCancel || 0, Math.max(askDepthForDef, EPS))) +
              0.35 * (askWith || 0) +
              0.3 * clamp01(safeDiv(askExec || 0, Math.max((askExec || 0) + (askRefill || 0), EPS)))
          );
    const bidWeakenRaw =
      bidDepthForDef == null
        ? null
        : clamp01(
            0.35 * clamp01(safeDiv(bidCancel || 0, Math.max(bidDepthForDef, EPS))) +
              0.35 * (bidWith || 0) +
              0.3 * clamp01(safeDiv(bidExec || 0, Math.max((bidExec || 0) + (bidRefill || 0), EPS)))
          );

    const prefix = `w${windowSec}`;
    const n = (name, value) => this.norm.observe(`${prefix}:${name}`, value, regime);

    const buyAggC = n("buyAgg", buyVol);
    const sellAggC = n("sellAgg", sellVol);
    const buyVelC = n("buyVel", buyVel);
    const sellVelC = n("sellVel", sellVel);
    const buyIntC = n("buyInt", buyIntensity);
    const sellIntC = n("sellInt", sellIntensity);
    const buyImbC = n("buyImb", buyImb);
    const sellImbC = n("sellImb", sellImb);
    const largeBuyC = n("largeBuy", largeBuy);
    const largeSellC = n("largeSell", largeSell);
    const buyDeltaC = n("buyDelta", buyDelta);
    const sellDeltaC = n("sellDelta", sellDelta);
    const buyCvdC = n("buyCvd", buyCvd);
    const sellCvdC = n("sellCvd", sellCvd);
    const askCancelC = n("askCancel", askCancel);
    const bidCancelC = n("bidCancel", bidCancel);
    const askWithC = n("askWith", askWith);
    const bidWithC = n("bidWith", bidWith);
    const askExecC = n("askExec", askExec);
    const bidExecC = n("bidExec", bidExec);
    const askRefillC = n("askRefill", askRefill);
    const bidRefillC = n("bidRefill", bidRefill);
    const askSurvC = n("askSurv", askSurv);
    const bidSurvC = n("bidSurv", bidSurv);
    const askDepthC = n("askDepth", askDepthForDef);
    const bidDepthC = n("bidDepth", bidDepthForDef);
    const nearAskC = n("nearAsk", nearAskForDef);
    const nearBidC = n("nearBid", nearBidForDef);
    const askPersC = n("askPers", askPersist);
    const bidPersC = n("bidPers", bidPersist);
    const askWeakC = n("askWeak", askWeakenRaw);
    const bidWeakC = n("bidWeak", bidWeakenRaw);
    const askConcC = n("askConc", depth.askConc);
    const bidConcC = n("bidConc", depth.bidConc);
    const askApproachC = n("askApproach", approach.ask);
    const bidApproachC = n("bidApproach", approach.bid);
    const askUnrepC = n("askUnrep", askUnreplaced);
    const bidUnrepC = n("bidUnrep", bidUnreplaced);
    const askChurnC = n("askChurn", askChurn);
    const bidChurnC = n("bidChurn", bidChurn);

    const BuyAggressionPower = missingTrades ? null : buyAggC.power;
    const SellAggressionPower = missingTrades ? null : sellAggC.power;
    const BuyExecutionVelocity = missingTrades ? null : buyVelC.power;
    const SellExecutionVelocity = missingTrades ? null : sellVelC.power;
    const BuyImbalanceStrength = missingTrades ? null : buyImbC.power;
    const SellImbalanceStrength = missingTrades ? null : sellImbC.power;
    const AskCancellation = missingBook || stale ? null : askCancelC.power;
    const BidCancellation = missingBook || stale ? null : bidCancelC.power;
    const AskWithdrawal = missingBook || stale ? null : askWithC.power;
    const BidWithdrawal = missingBook || stale ? null : bidWithC.power;
    const AskConsumption = missingBook || stale ? null : askExecC.power;
    const BidConsumption = missingBook || stale ? null : bidExecC.power;
    const AskReplenishment = missingBook || stale ? null : askRefillC.power;
    const BidReplenishment = missingBook || stale ? null : bidRefillC.power;
    const AskSurvival = missingBook || stale ? null : askSurvC.power;
    const BidSurvival = missingBook || stale ? null : bidSurvC.power;
    const AskDepthThinness = missingBook || stale ? null : this.norm.thinnessPower(askDepthC);
    const BidDepthThinness = missingBook || stale ? null : this.norm.thinnessPower(bidDepthC);
    const nearAskFall = missingBook || stale ? null : this.norm.thinnessPower(askConcC);
    const nearBidFall = missingBook || stale ? null : this.norm.thinnessPower(bidConcC);
    const AskApproach = askApproachC.power;
    const BidApproach = bidApproachC.power;

    const askDefFeat = {
      survivalFall: AskSurvival == null ? null : invertScore(AskSurvival),
      depthFall: AskDepthThinness,
      cancellation: AskCancellation,
      replenishFall: AskReplenishment == null ? null : invertScore(AskReplenishment),
      wallApproach: askWall,
      consumedUnreplaced: askUnrepC.power,
    };
    const bidDefFeat = {
      survivalFall: BidSurvival == null ? null : invertScore(BidSurvival),
      depthFall: BidDepthThinness,
      cancellation: BidCancellation,
      replenishFall: BidReplenishment == null ? null : invertScore(BidReplenishment),
      wallApproach: bidWall,
      consumedUnreplaced: bidUnrepC.power,
    };
    const askDef = this.defense.score(askDefFeat);
    const bidDef = this.defense.score(bidDefFeat);

    const defWeights = this.weights.passiveDefense || PRE_MOVE_WEIGHTS.passiveDefense;
    const PassiveSellerDefense =
      missingBook || stale
        ? null
        : combineWeighted(defWeights, {
            depth: askDepthC.power,
            nearTouch: nearAskC.power,
            replenishment: AskReplenishment,
            survival: AskSurvival,
            persistence: askPersC.power,
            cancellation: AskCancellation,
            withdrawal: AskWithdrawal,
            consumption: AskConsumption,
            defenseWeakening: askWeakC.power,
          }).score;
    const PassiveBuyerDefense =
      missingBook || stale
        ? null
        : combineWeighted(defWeights, {
            depth: bidDepthC.power,
            nearTouch: nearBidC.power,
            replenishment: BidReplenishment,
            survival: BidSurvival,
            persistence: bidPersC.power,
            cancellation: BidCancellation,
            withdrawal: BidWithdrawal,
            consumption: BidConsumption,
            defenseWeakening: bidWeakC.power,
          }).score;

    const bookUp = this.bookPrep.score({
      depthThinness: AskDepthThinness,
      cancellation: AskCancellation,
      withdrawal: AskWithdrawal,
      survivalFall: AskSurvival == null ? null : invertScore(AskSurvival),
      approachWithdrawal: AskApproach,
      nearTouchFall: nearAskFall,
      replenishWeak: AskReplenishment == null ? null : invertScore(AskReplenishment),
    });
    const bookDown = this.bookPrep.score({
      depthThinness: BidDepthThinness,
      cancellation: BidCancellation,
      withdrawal: BidWithdrawal,
      survivalFall: BidSurvival == null ? null : invertScore(BidSurvival),
      approachWithdrawal: BidApproach,
      nearTouchFall: nearBidFall,
      replenishWeak: BidReplenishment == null ? null : invertScore(BidReplenishment),
    });

    // Main score: attack + book prep + defense weakening vs PassiveDefense (no raw cancel/etc.)
    const upFeat = {
      BuyAggressionPower,
      BuyExecutionVelocity,
      BuyImbalanceStrength,
      upsideBookPreparation: bookUp.score,
      AskDefenseWeakening: askDef.score,
      PassiveSellerDefense,
    };
    const downFeat = {
      SellAggressionPower,
      SellExecutionVelocity,
      SellImbalanceStrength,
      downsideBookPreparation: bookDown.score,
      BidDefenseWeakening: bidDef.score,
      PassiveBuyerDefense,
    };

    const upCombo = combineWeighted(this.weights.up, upFeat);
    const downCombo = combineWeighted(this.weights.down, downFeat);

    const attackUp = combineWeighted(this.weights.attack, {
      aggression: BuyAggressionPower,
      velocity: BuyExecutionVelocity,
      intensity: buyIntC.power,
      imbalance: BuyImbalanceStrength,
      large: largeBuyC.power,
      delta: buyDeltaC.power,
      cvd: buyCvdC.power,
    });
    const attackDown = combineWeighted(this.weights.attack, {
      aggression: SellAggressionPower,
      velocity: SellExecutionVelocity,
      intensity: sellIntC.power,
      imbalance: SellImbalanceStrength,
      large: largeSellC.power,
      delta: sellDeltaC.power,
      cvd: sellCvdC.power,
    });

    const up = missingTrades ? null : upCombo.score;
    const down = missingTrades ? null : downCombo.score;
    const imbalance =
      up == null || down == null ? null : clamp(up - down, -100, 100);
    const normalizedImbalance =
      up == null || down == null ? null : (up - down) / Math.max(up + down, EPS);

    const UpsideBattleSpread =
      attackUp.score != null && PassiveSellerDefense != null
        ? Math.round(attackUp.score - PassiveSellerDefense)
        : null;
    const DownsideBattleSpread =
      attackDown.score != null && PassiveBuyerDefense != null
        ? Math.round(attackDown.score - PassiveBuyerDefense)
        : null;

    const wHist = this.windowHistory[windowSec] || (this.windowHistory[windowSec] = []);
    const motion = this.accel.measure(wHist, now, up ?? 50, down ?? 50);
    const upPers = this.persist.measure(wHist, now, up ?? 50, "up");
    const downPers = this.persist.measure(wHist, now, down ?? 50, "down");
    if (up != null && down != null) wHist.push({ t: now, up, down });
    while (wHist.length > (this.config.historyMaxPoints || 4200)) wHist.shift();

    // Diagnostic features (not in main combiner) kept for details / WHY
    const diagnostic = {
      AskCancellation,
      AskWithdrawal,
      AskConsumption,
      AskDepthThinness,
      AskReplenishment,
      AskSurvival,
      BidCancellation,
      BidWithdrawal,
      BidConsumption,
      BidDepthThinness,
      BidReplenishment,
      BidSurvival,
      AskDepth: askDepthC.power,
      BidDepth: bidDepthC.power,
      NearAskDepth: nearAskC.power,
      NearBidDepth: nearBidC.power,
      AskPersistence: askPersC.power,
      BidPersistence: bidPersC.power,
    };

    const features = {
      ...upFeat,
      ...downFeat,
      ...diagnostic,
      LargeBuyActivity: largeBuyC.power,
      LargeSellActivity: largeSellC.power,
      BuyTradeIntensity: buyIntC.power,
      SellTradeIntensity: sellIntC.power,
      BuyDeltaContribution: buyDeltaC.power,
      SellDeltaContribution: sellDeltaC.power,
      BuyCvdContribution: buyCvdC.power,
      SellCvdContribution: sellCvdC.power,
      AskChurn: askChurnC.power,
      BidChurn: bidChurnC.power,
      AskApproach,
      BidApproach,
      AggressiveBuyPower: attackUp.score,
      AggressiveSellPower: attackDown.score,
      PassiveSellerDefense,
      PassiveBuyerDefense,
    };

    const percentiles = {
      AskWithdrawal: askWithC.percentile,
      BidWithdrawal: bidWithC.percentile,
      AskCancellation: askCancelC.percentile,
      BidCancellation: bidCancelC.percentile,
      AskReplenishment: askRefillC.percentile,
      BidReplenishment: bidRefillC.percentile,
      AskDepth: askDepthC.percentile,
      BidDepth: bidDepthC.percentile,
      BuyAggressionPower: buyAggC.percentile,
      SellAggressionPower: sellAggC.percentile,
    };

    const up10 = pressureAt(wHist, now, 10, "up");
    const up30 = pressureAt(wHist, now, 30, "up");
    const down10 = pressureAt(wHist, now, 10, "down");
    const down30 = pressureAt(wHist, now, 30, "down");

    return {
      windowSec,
      upPressure: up,
      downPressure: down,
      pressureImbalance: imbalance == null ? null : Math.round(imbalance),
      normalizedImbalance:
        normalizedImbalance == null ? null : Math.round(normalizedImbalance * 1000) / 1000,
      upVelocity: motion.upVelocity,
      downVelocity: motion.downVelocity,
      upAcceleration: motion.upAcceleration,
      downAcceleration: motion.downAcceleration,
      upTrend: motion.upTrend,
      downTrend: motion.downTrend,
      velocityLookbackSec: motion.lookbackSec,
      velocityByWindow: motion.byWindow,
      upPersistence: upPers,
      downPersistence: downPers,
      upsideBookPreparation: bookUp.score,
      downsideBookPreparation: bookDown.score,
      upsideAttackScore: attackUp.score,
      downsideAttackScore: attackDown.score,
      AggressiveBuyPower: attackUp.score,
      AggressiveSellPower: attackDown.score,
      PassiveSellerDefense,
      PassiveBuyerDefense,
      UpsideBattleSpread,
      DownsideBattleSpread,
      askDefenseWeakening: askDef.score,
      bidDefenseWeakening: bidDef.score,
      depthSource: { ask: askDepthSource, bid: bidDepthSource },
      dataQuality: {
        trades: missingTrades ? "NO_DATA" : buyVol === 0 && sellVol === 0 ? "REAL_ZERO" : "OK",
        book: missingBook ? "NO_DATA" : stale ? "STALE" : "OK",
      },
      breakdown: {
        upside: {
          attackPower: attackUp.score,
          bookPreparation: bookUp.score,
          askDefenseWeakening: askDef.score,
          passiveSellerDefense: PassiveSellerDefense,
          askConsumption: AskConsumption,
          askWithdrawal: AskWithdrawal,
          askReplenishment: AskReplenishment,
          askSurvival: AskSurvival,
          battleSpread: UpsideBattleSpread,
        },
        downside: {
          attackPower: attackDown.score,
          bookPreparation: bookDown.score,
          bidDefenseWeakening: bidDef.score,
          passiveBuyerDefense: PassiveBuyerDefense,
          bidConsumption: BidConsumption,
          bidWithdrawal: BidWithdrawal,
          bidReplenishment: BidReplenishment,
          bidSurvival: BidSurvival,
          battleSpread: DownsideBattleSpread,
        },
      },
      context: {
        upNow: up,
        up10s: up10,
        up30s: up30,
        downNow: down,
        down10s: down10,
        down30s: down30,
      },
      features,
      raw: {
        buyVol,
        sellVol,
        buyVel,
        sellVel,
        askCancel,
        bidCancel,
        askExec,
        bidExec,
        askRefill,
        bidRefill,
        askDepthCurrent: depth.askDepth,
        bidDepthCurrent: depth.bidDepth,
        askDepthWindowed: askDepthWin,
        bidDepthWindowed: bidDepthWin,
        nearAskCurrent: depth.nearAsk,
        nearBidCurrent: depth.nearBid,
        nearAskWindowed: nearAskWin,
        nearBidWindowed: nearBidWin,
        bookImbalance: depth.bookImbalance,
      },
      percentiles,
      upContributions: upCombo.contributions,
      downContributions: downCombo.contributions,
    };
  }

  _approach(now, priceNow, liqWindows) {
    const then = this.depthHist.find((d) => now - d.t >= 8) || this.depthHist[0];
    if (!then || !Number.isFinite(priceNow) || !Number.isFinite(then.mid)) {
      return { ask: 0, bid: 0 };
    }
    const liq = liqWindows[10] || liqWindows[5] || {};
    const midUp = priceNow > then.mid;
    const midDown = priceNow < then.mid;
    const askDrop = Math.max(0, then.nearAsk - (this.depthHist[this.depthHist.length - 1]?.nearAsk || 0));
    const bidDrop = Math.max(0, then.nearBid - (this.depthHist[this.depthHist.length - 1]?.nearBid || 0));
    const askPull = Math.max(0, askDrop - (liq.askExec || 0) * 0.15);
    const bidPull = Math.max(0, bidDrop - (liq.bidExec || 0) * 0.15);
    return {
      ask: midUp ? safeDiv(askPull, Math.max(then.nearAsk, EPS)) : safeDiv(askPull, Math.max(then.nearAsk, EPS)) * 0.35,
      bid: midDown ? safeDiv(bidPull, Math.max(then.nearBid, EPS)) : safeDiv(bidPull, Math.max(then.nearBid, EPS)) * 0.35,
    };
  }

  _regime(priceHistory, now) {
    if (!priceHistory?.length) return "NORMAL";
    const rets = [];
    let prev = null;
    for (const p of priceHistory) {
      if (now - p.ts > 60) continue;
      if (prev && prev > 0) rets.push((p.price - prev) / prev);
      prev = p.price;
    }
    const vol = stdev(rets);
    const ctx = this.norm.observe("realizedVol", vol, "ALL");
    if (ctx.percentile == null) return "NORMAL";
    if (ctx.percentile < 0.33) return "LOW";
    if (ctx.percentile > 0.67) return "HIGH";
    return "NORMAL";
  }

  _alignment(byWindow) {
    let up = 0;
    let down = 0;
    let flat = 0;
    const n = this.windows.length;
    for (const w of this.windows) {
      const c = byWindow[w];
      if (!c || c.upPressure == null || c.downPressure == null) {
        flat += 1;
        continue;
      }
      const d = c.upPressure - c.downPressure;
      if (d >= 10) up += 1;
      else if (d <= -10) down += 1;
      else flat += 1;
    }
    const score = score100(Math.abs(up - down) / Math.max(n, 1));
    let label = "MIXED";
    if (up === n) label = "MULTI_TIMEFRAME_UP_PRESSURE";
    else if (down === n) label = "MULTI_TIMEFRAME_DOWN_PRESSURE";
    else if (up >= n - 1 && down === 0) label = "MULTI_TIMEFRAME_UP_PRESSURE";
    else if (down >= n - 1 && up === 0) label = "MULTI_TIMEFRAME_DOWN_PRESSURE";
    return { score, label, upCount: up, downCount: down, flatCount: flat };
  }

  _confidence(ctx, primary) {
    const tradesReady = !!ctx.tradesReady;
    const bookReady = !!ctx.bookReady;
    const stale = !!ctx.staleBook || !bookReady;
    const lastTradeAge = ctx.lastTradeAge ?? 0;
    const lastBookAge = ctx.lastBookAge ?? 0;
    const samples = this.norm.sampleCount(`w${this.primaryWindow}:buyAgg`);
    const sampleScore = score100(samples / 40);
    const tradeScore = tradesReady && lastTradeAge < 8 ? 100 : tradesReady ? 55 : 15;
    const bookScore = bookReady && lastBookAge < 2 ? 100 : bookReady ? 50 : 20;
    const seqScore = lastBookAge < 2 && lastTradeAge < 8 ? 90 : 40;
    const venueScore = 82; // single-exchange coverage
    let stability = 80;
    if (this.history.length >= 8) {
      const last = this.history.slice(-8).map((h) => h.up);
      const sd = stdev(last);
      if (sd > 18 && (primary.upPersistence?.label === "TRANSIENT" || primary.downPersistence?.label === "TRANSIENT")) {
        stability = 35;
      } else if (sd > 12) stability = 55;
    }
    const recon = this._recon(ctx, primary);

    let c =
      0.22 * tradeScore +
      0.22 * bookScore +
      0.14 * seqScore +
      0.14 * sampleScore +
      0.12 * stability +
      0.08 * venueScore +
      0.08 * recon;

    if (stale || !tradesReady) c = Math.min(c, 32);
    return clamp(c, 0, 100);
  }

  _recon(ctx, primary) {
    const w = this.primaryWindow;
    const flow = ctx.flowWindows[w] || {};
    const liq = ctx.liqWindows[w] || {};
    const buy = flow.aggressiveBuyVolume || 0;
    const exec = liq.askExec || 0;
    if (buy <= 0 && sellSafe(flow) <= 0) return 70;
    const ratio = safeDiv(Math.min(buy, exec), Math.max(buy, exec, EPS));
    return score100(0.4 + 0.6 * ratio);
  }
}

function sellSafe(flow) {
  return flow.aggressiveSellVolume || 0;
}
