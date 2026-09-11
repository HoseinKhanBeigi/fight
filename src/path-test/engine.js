/**
 * Path-test engine.
 *
 * Observes live (or historical) snapshots, freezes features at T, then labels
 * the next 15 minutes. Does not modify battle / pre-move scoring.
 */

import {
  HORIZON_SEC,
  MIN_SAMPLES_FOR_RATE,
  PREDICTION,
} from "./constants.js";
import { labelPath, outcomePending } from "./outcomes.js";
import { buildSnapshot } from "./snapshot.js";
import { CausalNormalizer, freezeDeep } from "./math.js";
import { getStrategy, strategyFingerprint } from "./strategy.js";
import { PathTestStore } from "./store.js";
import {
  ablationReport,
  barrierGrid,
  byRegime,
  bySession,
  comparisonTable,
  confidenceBuckets,
  correlationReport,
  excursionStats,
  scoreBuckets,
  stabilityByPeriod,
  summarizeRows,
  timeSplits,
  walkForward,
} from "./metrics.js";

export class PathTestEngine {
  constructor(opts = {}) {
    this.strategy = opts.strategy || getStrategy(opts.strategyVersion);
    this.mode = opts.mode || "FORWARD";
    this.horizonSec = opts.horizonSec || this.strategy.horizonSec || HORIZON_SEC;
    this.sampleIntervalSec = opts.sampleIntervalSec ?? 15;
    this.maxCompleted = opts.maxCompleted ?? 8000;
    // The tick ring must outlive the horizon, otherwise the start of a path is
    // trimmed away before the outcome can be labelled.
    this.maxTicks = opts.maxTicks ?? 250_000;
    this.maxGapSec = opts.maxGapSec ?? 90;
    this.minSamples = opts.minSamples ?? this.strategy.thresholds.minSamples ?? MIN_SAMPLES_FOR_RATE;
    this.selectedTimeframe = opts.selectedTimeframe ?? 60;
    this.exchange = opts.exchange || "BINANCE";
    this.marketType = opts.marketType || "USDM_FUTURES";
    this.norm = new CausalNormalizer({
      maxSamples: this.strategy.normalizationConfig.maxSamples,
      minSamples: this.strategy.normalizationConfig.minSamples,
    });
    /** @type {Array<{t:number, price:number}>} */
    this.ticks = [];
    /** @type {object[]} */
    this.open = [];
    /** @type {object[]} */
    this.completed = [];
    this.lastSampleT = -Infinity;
    this.metricsCache = null;
    this.viewCache = null;
    this.viewAt = 0;
    this.viewTtlMs = opts.viewTtlMs ?? 1000;
    this.todayKey = null;
    this._seqSeen = 0;
    // Every open signal needs its own slot until its horizon elapses.
    const perHorizon = Math.ceil(this.horizonSec / Math.max(this.sampleIntervalSec, 0.25)) + 2;
    this.maxOpen = opts.maxOpen ?? Math.max(perHorizon * 2, 500);
    this.dropped = { uncoveredTicks: 0, overflow: 0, gappy: 0, abandonedOnRestart: 0 };

    // Opt-in so replays and tests never write to the live data files.
    this.store =
      opts.store ||
      (opts.persist === true
        ? new PathTestStore({
            dir: opts.dataDir,
            symbol: opts.symbol,
            strategyVersion: this.strategy.version,
            fingerprint: strategyFingerprint(this.strategy),
            maxRows: this.maxCompleted,
          })
        : null);
  }

  /**
   * Restore completed rows from disk. Pending rows are not restored: their
   * price path was never observed, so they can only be counted as abandoned.
   */
  hydrate() {
    if (!this.store) return { completed: 0, abandoned: 0 };
    const loaded = this.store.load();
    if (loaded.completed.length) {
      this.completed = loaded.completed.concat(this.completed);
      while (this.completed.length > this.maxCompleted) this.completed.shift();
    }
    this.dropped.abandonedOnRestart += loaded.abandoned;
    this.metricsCache = null;
    this.viewCache = null;
    return { completed: loaded.completed.length, abandoned: loaded.abandoned, file: loaded.file };
  }

  clear({ keepCompleted = false } = {}) {
    this.ticks = [];
    this.open = [];
    this.lastSampleT = -Infinity;
    this.metricsCache = null;
    this.viewCache = null;
    if (!keepCompleted) {
      this.completed = [];
    }
    this.norm.clear();
  }

  /**
   * Earliest tick timestamp still required: feature lookbacks plus the full
   * path of the oldest signal whose horizon has not elapsed.
   */
  _retentionFloor(now) {
    const byLookback = now - (this.horizonSec + 300);
    const oldestOpen = this.open.length ? this.open[0].timestamp : Infinity;
    return Math.min(byLookback, oldestOpen);
  }

  pushPrice(t, price) {
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) return;
    const last = this.ticks[this.ticks.length - 1];
    // Barrier ordering depends on a sorted ring; feeds are ascending by design.
    if (last && t < last.t) return;
    if (last && last.t === t && last.price === price) return;
    this.ticks.push({ t, price });

    const floor = this._retentionFloor(t);
    while (this.ticks.length > 1 && this.ticks[0].t < floor) this.ticks.shift();
    // Hard cap is a memory valve only; trimming past the floor loses path data,
    // so affected rows are discarded rather than mislabelled.
    while (this.ticks.length > this.maxTicks) this.ticks.shift();
  }

  /**
   * Live observe. `live` is the monitor snapshot AFTER engines have scored.
   * Features are frozen from information at T only.
   */
  observe(live, extra = {}) {
    const now = Number.isFinite(extra.now)
      ? extra.now
      : Number.isFinite(live.ts)
        ? live.ts / 1000
        : Date.now() / 1000;
    const price = Number(live.price);
    const lastTickT = this.ticks[this.ticks.length - 1]?.t ?? -Infinity;
    if (extra.priceHistory?.length) {
      const hist = extra.priceHistory;
      let start = 0;
      for (let i = hist.length - 1; i >= 0; i--) {
        const ts = hist[i].ts ?? hist[i].t;
        if (ts <= lastTickT) {
          start = i + 1;
          break;
        }
      }
      for (let i = start; i < hist.length; i++) {
        const ts = hist[i].ts ?? hist[i].t;
        if (ts <= now) this.pushPrice(ts, hist[i].price);
      }
    }
    this.pushPrice(now, price);
    this._rollDay(now);
    this._resolveOpen(now);

    const ready = extra.bookReady !== false && extra.tradesReady !== false && live.ready !== false;
    const due = now - this.lastSampleT >= this.sampleIntervalSec - 1e-6;
    if (ready && due && Number.isFinite(price) && price > 0) {
      this._freeze(live, { ...extra, now });
      this.lastSampleT = now;
    }

    // The view is rebuilt from every completed row, so rebuilding it on each
    // 250ms broadcast is wasted work and wire bytes.
    const nowMs = Date.now();
    if (this.viewCache && nowMs - this.viewAt < this.viewTtlMs) return this.viewCache;
    this.viewCache = this.view(now);
    this.viewAt = nowMs;
    return this.viewCache;
  }

  /**
   * Sequential historical replay. Each row must contain only data known at row.t.
   */
  ingestHistorical(live, extra = {}) {
    const prevMode = this.mode;
    this.mode = "BACKTEST";
    const view = this.observe(live, extra);
    this.mode = prevMode;
    return view;
  }

  _freeze(live, extra) {
    const record = buildSnapshot(live, {
      now: extra.now,
      ticks: this.ticks,
      selectedTimeframe: extra.selectedTimeframe ?? this.selectedTimeframe,
      norm: this.norm,
      strategy: this.strategy,
      mode: this.mode,
      exchange: this.exchange,
      marketType: this.marketType,
      symbol: live.symbol,
      tradesReady: extra.tradesReady,
      bookReady: extra.bookReady,
      staleBook: extra.staleBook,
      lastTradeAge: extra.lastTradeAge,
      lastBookAge: extra.lastBookAge,
    });
    this.open.push(record);
    this.store?.appendSnapshot(record);
    this._seqSeen += 1;
    // Pending rows evicted here never get an outcome; count them instead of
    // letting them disappear silently.
    while (this.open.length > this.maxOpen) {
      this.open.shift();
      this.dropped.overflow += 1;
    }
    this.metricsCache = null;
    this.viewCache = null;
  }

  _resolveOpen(now) {
    if (!this.open.length) return;
    const firstTick = this.ticks[0]?.t ?? Infinity;
    const lastTick = this.ticks[this.ticks.length - 1]?.t ?? -Infinity;
    const still = [];
    let closed = 0;

    for (const row of this.open) {
      if (outcomePending(row.timestamp, this.horizonSec, now)) {
        still.push(row);
        continue;
      }
      // Do not label from a path the tick buffer never fully observed.
      if (lastTick + 1e-9 < row.timestamp + this.horizonSec) {
        still.push(row);
        continue;
      }
      if (firstTick > row.timestamp) {
        this.dropped.uncoveredTicks += 1;
        continue;
      }
      const outcome = labelPath({
        t0: row.timestamp,
        priceAtT: row.price,
        ticks: this.ticks,
        horizonSec: this.horizonSec,
        prediction: row.prediction?.label,
        now,
        maxGapSec: this.maxGapSec,
      });
      if (!outcome) {
        still.push(row);
        continue;
      }
      if (outcome.coverage === "GAPPY") this.dropped.gappy += 1;
      row.outcome = freezeDeep(outcome);
      this.store?.appendOutcome(row.id, outcome);
      this.completed.push(row);
      closed += 1;
    }

    this.open = still;
    while (this.completed.length > this.maxCompleted) this.completed.shift();
    if (closed) {
      this.metricsCache = null;
      this.viewCache = null;
    }
  }

  _rollDay(now) {
    this.todayKey = new Date(now * 1000).toISOString().slice(0, 10);
  }

  _metrics() {
    if (this.metricsCache) return this.metricsCache;
    const rows = this.completed;
    this.metricsCache = {
      full: summarizeRows(rows, { minSamples: this.minSamples }),
      comparison: comparisonTable(rows, this.minSamples),
      scoreBuckets: scoreBuckets(rows),
      confidenceBuckets: confidenceBuckets(rows),
      regimes: byRegime(rows),
      sessions: bySession(rows),
      excursions: excursionStats(rows, { minSamples: this.minSamples }),
      barrierGrid: barrierGrid(rows, { minSamples: this.minSamples }),
      ablation: rows.length >= this.minSamples ? ablationReport(rows, this.strategy) : [],
      correlation: rows.length >= this.minSamples ? correlationReport(rows) : { pairs: [], redundant: [] },
      splits: timeSplits(rows),
      walkForward: walkForward(rows),
      stability: stabilityByPeriod(rows, 3600),
    };
    return this.metricsCache;
  }

  dashboard(now = Date.now() / 1000) {
    const m = this._metrics();
    const full = m.full;
    const predCounts = { UP: 0, DOWN: 0, NO_EDGE: 0 };
    let todayUp = 0;
    let todayDown = 0;
    let todayNone = 0;
    const day = this.todayKey;
    for (const r of [...this.completed, ...this.open]) {
      const label = r.prediction?.label || PREDICTION.NO_EDGE;
      if (predCounts[label] != null) predCounts[label] += 1;
      const key = new Date(r.timestamp * 1000).toISOString().slice(0, 10);
      if (key === day) {
        if (label === PREDICTION.UP) todayUp += 1;
        else if (label === PREDICTION.DOWN) todayDown += 1;
        else todayNone += 1;
      }
    }
    return {
      strategyVersion: this.strategy.version,
      mode: this.mode,
      horizonSec: this.horizonSec,
      signalsToday: todayUp + todayDown,
      signalsTodayBreakdown: { UP: todayUp, DOWN: todayDown, NO_EDGE: todayNone },
      signalsTotal: predCounts.UP + predCounts.DOWN,
      predictions: predCounts,
      currentForwardAccuracy: full.overallHitRate,
      UP_FIRST: full.UP_FIRST,
      DOWN_FIRST: full.DOWN_FIRST,
      NEITHER: full.NEITHER,
      averageMFE: full.averageMFE,
      averageMAE: full.averageMAE,
      mfeMaeRatio: full.mfeMaeRatio,
      sampleSize: full.sampleCount,
      directionalCount: full.directionalCount,
      openCount: this.open.length,
      insufficient: full.insufficient,
      independence: full.independence,
      excludedGappy: full.excludedGappy,
      dropped: { ...this.dropped },
      store: this.store ? this.store.status() : { enabled: false },
    };
  }

  close() {
    this.store?.close();
  }

  signalLog(limit = 40) {
    const rows = [...this.completed, ...this.open]
      .filter((r) => r.prediction?.label && r.prediction.label !== PREDICTION.NO_EDGE)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
    return rows.map((r) => compactLogRow(r));
  }

  chartMarkers(now = Date.now() / 1000, windowSec = 900) {
    const t0 = now - windowSec;
    return [...this.completed, ...this.open]
      .filter((r) => r.timestamp >= t0 && r.prediction?.label && r.prediction.label !== PREDICTION.NO_EDGE)
      .map((r) => {
        const outcome = r.outcome?.firstBarrier050 || null;
        const pred = r.prediction.label;
        let correct = null;
        if (outcome) {
          correct =
            (pred === PREDICTION.UP && outcome === "UP_FIRST") ||
            (pred === PREDICTION.DOWN && outcome === "DOWN_FIRST");
        }
        return {
          t: r.timestampMs,
          timestamp: r.timestamp,
          direction: pred,
          score: r.prediction.directionalScore,
          confidence: r.prediction.confidence,
          outcome,
          pending: !r.outcome,
          correct,
          id: r.id,
        };
      });
  }

  view(now = Date.now() / 1000) {
    const metrics = this._metrics();
    return {
      strategyVersion: this.strategy.version,
      mode: this.mode,
      dashboard: this.dashboard(now),
      log: this.signalLog(48),
      chartMarkers: this.chartMarkers(now, 900),
      comparison: metrics.comparison,
      scoreBuckets: metrics.scoreBuckets,
      confidenceBuckets: metrics.confidenceBuckets,
      regimes: compactRegimes(metrics.regimes),
      sessions: compactSessions(metrics.sessions),
      excursions: metrics.excursions,
      barrierGrid: metrics.barrierGrid,
      ablation: metrics.ablation,
      correlation: metrics.correlation,
      splits: {
        TRAIN: slimSummary(metrics.splits.TRAIN),
        VALIDATION: slimSummary(metrics.splits.VALIDATION),
        TEST: slimSummary(metrics.splits.TEST),
        ranges: metrics.splits.ranges,
      },
      walkForward: {
        note: metrics.walkForward.note || null,
        folds: (metrics.walkForward.folds || []).map((f) => ({
          train: f.train,
          test: f.test,
          trainHit: f.trainMetrics.overallHitRate,
          testHit: f.testMetrics.overallHitRate,
        })),
      },
      stability: (metrics.stability || []).slice(-12).map((s) => ({
        from: s.from,
        to: s.to,
        sampleCount: s.sampleCount,
        hitRate: s.overallHitRate,
      })),
    };
  }
}

function compactLogRow(r) {
  const n = r.features?.normalized || {};
  const o = r.outcome;
  return {
    id: r.id,
    timestamp: r.timestamp,
    timestampMs: r.timestampMs,
    price: r.price,
    prediction: r.prediction?.label,
    directionalScore: r.prediction?.directionalScore,
    confidence: r.prediction?.confidence,
    state: r.prediction?.state,
    UpPressure: n.UpPressure,
    DownPressure: n.DownPressure,
    AggressiveBuyPower: n.AggressiveBuyPower,
    PassiveSellerDefense: n.PassiveSellerDefense,
    UpsideBattleSpread: n.UpsideBattleSpread,
    outcome: o?.firstBarrier050 || null,
    pending: !o,
    return15m: o?.return15m ?? null,
    maxUp15m: o?.maxUp15m ?? null,
    maxDown15m: o?.maxDown15m ?? null,
    MFE: o?.MFE ?? null,
    MAE: o?.MAE ?? null,
    correct: o
      ? (r.prediction?.label === PREDICTION.UP && o.firstBarrier050 === "UP_FIRST") ||
        (r.prediction?.label === PREDICTION.DOWN && o.firstBarrier050 === "DOWN_FIRST")
      : null,
  };
}

function slimSummary(s) {
  if (!s) return null;
  return {
    sampleCount: s.sampleCount,
    directionalCount: s.directionalCount,
    overallHitRate: s.overallHitRate,
    UP_FIRST: s.UP_FIRST,
    DOWN_FIRST: s.DOWN_FIRST,
    NEITHER: s.NEITHER,
    averageReturn15m: s.averageReturn15m,
    averageMFE: s.averageMFE,
    averageMAE: s.averageMAE,
    insufficient: s.insufficient,
  };
}

function compactRegimes(regimes) {
  const out = {};
  for (const [k, v] of Object.entries(regimes || {})) out[k] = slimSummary(v);
  return out;
}

function compactSessions(sessions) {
  return {
    ASIA: slimSummary(sessions?.ASIA),
    EUROPE: slimSummary(sessions?.EUROPE),
    US: slimSummary(sessions?.US),
    hourly: (sessions?.hourly || []).map((h) => ({
      hour: h.hour,
      sampleCount: h.sampleCount,
      overallHitRate: h.overallHitRate,
      insufficient: h.insufficient,
    })),
    dayOfWeek: (sessions?.dayOfWeek || []).map((d) => ({
      dayOfWeek: d.dayOfWeek,
      sampleCount: d.sampleCount,
      overallHitRate: d.overallHitRate,
    })),
  };
}

/**
 * Sequential historical backtest helper.
 * `rows` are live-shaped snapshots already causal at each timestamp.
 */
export function runBacktest(rows, opts = {}) {
  const engine = new PathTestEngine({
    ...opts,
    mode: "BACKTEST",
    sampleIntervalSec: 0,
    persist: false,
    store: null,
  });
  const stampOf = (row) => row?.t ?? row?.timestamp ?? row?.now;
  for (const row of rows) {
    engine.lastSampleT = -Infinity;
    engine.ingestHistorical(row.live || row, {
      now: stampOf(row),
      tradesReady: row.tradesReady ?? true,
      bookReady: row.bookReady ?? true,
      staleBook: row.staleBook ?? false,
    });
  }
  const lastT = stampOf(rows[rows.length - 1]) ?? engine.ticks[engine.ticks.length - 1]?.t;
  // Rows without a fully observed path stay open; they are not labelled here.
  if (Number.isFinite(lastT)) engine._resolveOpen(lastT + engine.horizonSec + 1);
  return engine;
}
