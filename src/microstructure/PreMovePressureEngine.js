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
    while (this.depthHist.length && now - this.depthHist[0].t > 120) this.depthHist.shift();

    const regime = this._regime(ctx.priceHistory, now);
    const approach = this._approach(now, ctx.priceNow, ctx.liqWindows);

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
            askDefenseWeakening: v.askDefenseWeakening,
            bidDefenseWeakening: v.bidDefenseWeakening,
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

  _scoreWindow({ windowSec, now, regime, depth, approach, flow, liq, walls, tick, priceNow }) {
    const buyVol = flow.aggressiveBuyVolume || 0;
    const sellVol = flow.aggressiveSellVolume || 0;
    const tot = buyVol + sellVol;
    const buyVel = safeDiv(buyVol, windowSec);
    const sellVel = safeDiv(sellVol, windowSec);
    const buyImb = tot > 0 ? Math.max(0, (buyVol - sellVol) / tot) : 0;
    const sellImb = tot > 0 ? Math.max(0, (sellVol - buyVol) / tot) : 0;
    const largeBuy = safeDiv(flow.largeBuyVolume || 0, Math.max(buyVol, EPS));
    const largeSell = safeDiv(flow.largeSellVolume || 0, Math.max(sellVol, EPS));

    const askCancel = liq.askCancel || 0;
    const bidCancel = liq.bidCancel || 0;
    const askRefill = liq.askRefill || 0;
    const bidRefill = liq.bidRefill || 0;
    const askExec = liq.askExec || 0;
    const bidExec = liq.bidExec || 0;
    const askStack = liq.askStack || 0;
    const bidStack = liq.bidStack || 0;

    const askSurv = survivalRaw(askExec, askCancel, askRefill, depth.askDepth);
    const bidSurv = survivalRaw(bidExec, bidCancel, bidRefill, depth.bidDepth);
    const askWith = withdrawalRaw(askCancel, askRefill);
    const bidWith = withdrawalRaw(bidCancel, bidRefill);
    const askChurn = safeDiv(askStack + askRefill + askCancel + askExec, depth.askDepth);
    const bidChurn = safeDiv(bidStack + bidRefill + bidCancel + bidExec, depth.bidDepth);
    const askUnreplaced = clamp01(safeDiv(askExec, Math.max(askExec + askRefill, EPS)));
    const bidUnreplaced = clamp01(safeDiv(bidExec, Math.max(bidExec + bidRefill, EPS)));

    const mid = priceNow;
    const askWall = wallApproachScore(walls?.largestAskWall, mid, tick, now);
    const bidWall = wallApproachScore(walls?.largestBidWall, mid, tick, now);

    const prefix = `w${windowSec}`;
    const n = (name, value) => this.norm.observe(`${prefix}:${name}`, value, regime);

    const buyAggC = n("buyAgg", buyVol);
    const sellAggC = n("sellAgg", sellVol);
    const buyVelC = n("buyVel", buyVel);
    const sellVelC = n("sellVel", sellVel);
    const buyImbC = n("buyImb", buyImb);
    const sellImbC = n("sellImb", sellImb);
    const largeBuyC = n("largeBuy", largeBuy);
    const largeSellC = n("largeSell", largeSell);
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
    const askDepthC = n("askDepth", depth.askDepth);
    const bidDepthC = n("bidDepth", depth.bidDepth);
    const askConcC = n("askConc", depth.askConc);
    const bidConcC = n("bidConc", depth.bidConc);
    const askApproachC = n("askApproach", approach.ask);
    const bidApproachC = n("bidApproach", approach.bid);
    const askUnrepC = n("askUnrep", askUnreplaced);
    const bidUnrepC = n("bidUnrep", bidUnreplaced);
    const askChurnC = n("askChurn", askChurn);
    const bidChurnC = n("bidChurn", bidChurn);

    const BuyAggressionPower = buyAggC.power;
    const SellAggressionPower = sellAggC.power;
    const BuyExecutionVelocity = buyVelC.power;
    const SellExecutionVelocity = sellVelC.power;
    const BuyImbalanceStrength = buyImbC.power;
    const SellImbalanceStrength = sellImbC.power;
    const AskCancellation = askCancelC.power;
    const BidCancellation = bidCancelC.power;
    const AskWithdrawal = askWithC.power;
    const BidWithdrawal = bidWithC.power;
    const AskConsumption = askExecC.power;
    const BidConsumption = bidExecC.power;
    const AskReplenishment = askRefillC.power;
    const BidReplenishment = bidRefillC.power;
    const AskSurvival = askSurvC.power;
    const BidSurvival = bidSurvC.power;
    const AskDepthThinness = this.norm.thinnessPower(askDepthC);
    const BidDepthThinness = this.norm.thinnessPower(bidDepthC);
    const nearAskFall = this.norm.thinnessPower(askConcC);
    const nearBidFall = this.norm.thinnessPower(bidConcC);
    const AskApproach = askApproachC.power;
    const BidApproach = bidApproachC.power;

    const askDefFeat = {
      survivalFall: invertScore(AskSurvival),
      depthFall: AskDepthThinness,
      cancellation: AskCancellation,
      replenishFall: invertScore(AskReplenishment),
      wallApproach: askWall,
      consumedUnreplaced: askUnrepC.power,
    };
    const bidDefFeat = {
      survivalFall: invertScore(BidSurvival),
      depthFall: BidDepthThinness,
      cancellation: BidCancellation,
      replenishFall: invertScore(BidReplenishment),
      wallApproach: bidWall,
      consumedUnreplaced: bidUnrepC.power,
    };
    const askDef = this.defense.score(askDefFeat);
    const bidDef = this.defense.score(bidDefFeat);

    const PassiveSellerDefense = clamp(
      Math.round(0.5 * AskSurvival + 0.3 * AskReplenishment + 0.2 * (100 - AskWithdrawal)),
      0,
      100
    );
    const PassiveBuyerDefense = clamp(
      Math.round(0.5 * BidSurvival + 0.3 * BidReplenishment + 0.2 * (100 - BidWithdrawal)),
      0,
      100
    );

    const upFeat = {
      BuyAggressionPower,
      BuyExecutionVelocity,
      BuyImbalanceStrength,
      AskCancellation,
      AskWithdrawal,
      AskConsumption,
      AskDepthThinness,
      AskDefenseWeakening: askDef.score,
      AskReplenishment,
      AskSurvival,
      PassiveSellerDefense,
    };
    const downFeat = {
      SellAggressionPower,
      SellExecutionVelocity,
      SellImbalanceStrength,
      BidCancellation,
      BidWithdrawal,
      BidConsumption,
      BidDepthThinness,
      BidDefenseWeakening: bidDef.score,
      BidReplenishment,
      BidSurvival,
      PassiveBuyerDefense,
    };

    const upCombo = combineWeighted(this.weights.up, upFeat);
    const downCombo = combineWeighted(this.weights.down, downFeat);

    const attackUp = combineWeighted(this.weights.attack, {
      aggression: BuyAggressionPower,
      velocity: BuyExecutionVelocity,
      imbalance: BuyImbalanceStrength,
      large: largeBuyC.power,
    });
    const attackDown = combineWeighted(this.weights.attack, {
      aggression: SellAggressionPower,
      velocity: SellExecutionVelocity,
      imbalance: SellImbalanceStrength,
      large: largeSellC.power,
    });

    const bookUp = this.bookPrep.score({
      depthThinness: AskDepthThinness,
      cancellation: AskCancellation,
      withdrawal: AskWithdrawal,
      survivalFall: invertScore(AskSurvival),
      approachWithdrawal: AskApproach,
      nearTouchFall: nearAskFall,
      replenishWeak: invertScore(AskReplenishment),
    });
    const bookDown = this.bookPrep.score({
      depthThinness: BidDepthThinness,
      cancellation: BidCancellation,
      withdrawal: BidWithdrawal,
      survivalFall: invertScore(BidSurvival),
      approachWithdrawal: BidApproach,
      nearTouchFall: nearBidFall,
      replenishWeak: invertScore(BidReplenishment),
    });

    const up = upCombo.score;
    const down = downCombo.score;
    const imbalance = clamp(up - down, -100, 100);
    const normalizedImbalance = (up - down) / Math.max(up + down, EPS);

    const wHist = this.windowHistory[windowSec] || (this.windowHistory[windowSec] = []);
    const motion = this.accel.measure(wHist, now, up, down);
    const upPers = this.persist.measure(wHist, now, up, "up");
    const downPers = this.persist.measure(wHist, now, down, "down");
    wHist.push({ t: now, up, down });
    while (wHist.length > (this.config.historyMaxPoints || 4200)) wHist.shift();

    const features = {
      ...upFeat,
      ...downFeat,
      LargeBuyActivity: largeBuyC.power,
      LargeSellActivity: largeSellC.power,
      AskChurn: askChurnC.power,
      BidChurn: bidChurnC.power,
      AskApproach,
      BidApproach,
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
      pressureImbalance: Math.round(imbalance),
      normalizedImbalance: Math.round(normalizedImbalance * 1000) / 1000,
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
      askDefenseWeakening: askDef.score,
      bidDefenseWeakening: bidDef.score,
      breakdown: {
        upside: {
          attackPower: attackUp.score,
          bookPreparation: bookUp.score,
          askDefenseWeakening: askDef.score,
          askConsumption: AskConsumption,
          askWithdrawal: AskWithdrawal,
          askReplenishment: AskReplenishment,
          askSurvival: AskSurvival,
        },
        downside: {
          attackPower: attackDown.score,
          bookPreparation: bookDown.score,
          bidDefenseWeakening: bidDef.score,
          bidConsumption: BidConsumption,
          bidWithdrawal: BidWithdrawal,
          bidReplenishment: BidReplenishment,
          bidSurvival: BidSurvival,
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
        askDepth: depth.askDepth,
        bidDepth: depth.bidDepth,
        nearAsk: depth.nearAsk,
        nearBid: depth.nearBid,
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
      if (!c) continue;
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
