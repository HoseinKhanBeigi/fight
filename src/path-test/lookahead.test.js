/**
 * Automated lookahead, labeling, and scoring tests for path-test v1.
 * Run: node --test src/path-test/*.test.js
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CausalNormalizer, freezeDeep } from "./math.js";
import { labelPath } from "./outcomes.js";
import { confidenceFactor, scoreBaselines, scoreFullModel, scoreSnapshot } from "./scores.js";
import { FIRST_BARRIER, PREDICTION } from "./constants.js";
import { barrierGrid, excursionStats, timeSplits, walkForward, summarizeRows } from "./metrics.js";
import { PathTestEngine, runBacktest } from "./engine.js";
import { mapEngineState } from "./snapshot.js";
import { STRATEGY_PREMOVE_V1_0, getStrategy } from "./strategy.js";
import { replayRowsFromFile } from "./store.js";
import { rescoreRecorded } from "./replay.js";

describe("causal normalizer — no future samples", () => {
  it("percentile at T uses only prior observations", () => {
    const n = new CausalNormalizer({ minSamples: 3, maxSamples: 20 });
    n.observe("x", 10);
    n.observe("x", 20);
    n.observe("x", 30);
    const at40 = n.peek("x", 40);
    assert.equal(at40.samples, 3);
    assert.ok(at40.percentile > 0.99);
    n.observe("x", 40);
    n.observe("x", 1000);
    const afterFuture = n.peek("x", 40);
    assert.notEqual(afterFuture.percentile, at40.percentile);
    assert.ok(afterFuture.percentile < at40.percentile);
  });

  it("missing values stay null, never 0", () => {
    const n = new CausalNormalizer({ minSamples: 2 });
    const ctx = n.observe("x", null);
    assert.equal(ctx.power, null);
    assert.equal(ctx.percentile, null);
    assert.equal(n.sampleCount("x"), 0);
  });
});

describe("path labeling — no lookahead", () => {
  it("ignores ticks at or before T and after the 15m horizon", () => {
    const t0 = 1_000;
    const price = 100_000;
    const ticks = [
      { t: 999, price: 101_000 },
      { t: t0, price: 102_000 },
      { t: t0 + 10, price: 100_200 },
      { t: t0 + 901, price: 101_000 },
    ];
    const out = labelPath({
      t0,
      priceAtT: price,
      ticks,
      horizonSec: 900,
      prediction: PREDICTION.UP,
      now: t0 + 900,
    });
    assert.equal(out.firstBarrier050, FIRST_BARRIER.NEITHER);
    assert.ok(out.maxUp15m < 0.005);
    assert.ok(Math.abs(out.return15m - 0.002) < 1e-9);
  });

  it("classifies UP_FIRST when the upper barrier is touched first", () => {
    const t0 = 0;
    const price = 100_000;
    const ticks = [
      { t: 5, price: 100_200 },
      { t: 10, price: 100_500 },
      { t: 20, price: 99_400 },
    ];
    const out = labelPath({
      t0,
      priceAtT: price,
      ticks,
      horizonSec: 900,
      prediction: PREDICTION.UP,
      now: 900,
    });
    assert.equal(out.firstBarrier050, FIRST_BARRIER.UP_FIRST);
    assert.equal(out.HitUp050, true);
    assert.equal(out.HitDown050, true);
    assert.ok(out.TimeToUp050 < out.TimeToDown050);
  });

  it("classifies DOWN_FIRST when the lower barrier is touched first", () => {
    const t0 = 0;
    const price = 100_000;
    const ticks = [
      { t: 3, price: 99_500 },
      { t: 8, price: 100_800 },
    ];
    const out = labelPath({
      t0,
      priceAtT: price,
      ticks,
      horizonSec: 900,
      prediction: PREDICTION.DOWN,
      now: 900,
    });
    assert.equal(out.firstBarrier050, FIRST_BARRIER.DOWN_FIRST);
  });

  it("returns null while the 15m horizon is still open", () => {
    const out = labelPath({
      t0: 0,
      priceAtT: 100,
      ticks: [{ t: 10, price: 101 }],
      now: 100,
      horizonSec: 900,
    });
    assert.equal(out, null);
  });

  it("inverts MAE/MFE for bearish predictions", () => {
    const t0 = 0;
    const price = 100;
    const ticks = [
      { t: 10, price: 101 },
      { t: 20, price: 98 },
    ];
    const bull = labelPath({ t0, priceAtT: price, ticks, prediction: PREDICTION.UP, now: 900 });
    const bear = labelPath({ t0, priceAtT: price, ticks, prediction: PREDICTION.DOWN, now: 900 });
    assert.ok(Math.abs(bull.MFE - 0.01) < 1e-9);
    assert.ok(Math.abs(bull.MAE - 0.02) < 1e-9);
    assert.ok(Math.abs(bear.MFE - 0.02) < 1e-9);
    assert.ok(Math.abs(bear.MAE - 0.01) < 1e-9);
  });
});

describe("confidence is non-directional", () => {
  it("does not flip DirectionalScore sign when confidence changes", () => {
    const base = {
      AggressiveBuyPower: 80,
      AggressiveSellPower: 20,
      PassiveSellerDefense: 20,
      PassiveBuyerDefense: 80,
      AskCancellation: 80,
      BidCancellation: 20,
      AskReplenishment: 20,
      BidReplenishment: 80,
      AskConsumption: 70,
      BidConsumption: 20,
      AskSurvival: 20,
      BidSurvival: 80,
      UpsideBattleSpread: 80,
      DownsideBattleSpread: 20,
      UpPressure: 85,
      DownPressure: 25,
      UpPressureAcceleration: 70,
      DownPressureAcceleration: 30,
      BookImbalance: 80,
      UpsideBookContext: 75,
      DownsideBookContext: 25,
    };
    const hi = scoreFullModel({ ...base, Confidence: 90 });
    const lo = scoreFullModel({ ...base, Confidence: 10 });
    assert.ok(hi.directionalScore > 0);
    assert.equal(hi.directionalScore, lo.directionalScore);
    assert.ok(hi.finalDirectionalStrength > lo.finalDirectionalStrength);
    assert.equal(Math.sign(hi.directionalScore), Math.sign(lo.directionalScore));
    const fHi = confidenceFactor(90);
    const fLo = confidenceFactor(10);
    assert.ok(fHi > fLo);
  });
});

describe("immutable snapshots", () => {
  it("does not allow feature overwrite after freeze", () => {
    const features = freezeDeep({ raw: { AskCancellation: 1 }, normalized: { AskCancellation: 93 } });
    assert.throws(() => {
      features.normalized.AskCancellation = 1;
    });
    assert.equal(features.normalized.AskCancellation, 93);
  });
});

describe("train / validation / test and walk-forward", () => {
  function fakeRows(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        timestamp: i * 60,
        prediction: { label: i % 2 ? PREDICTION.UP : PREDICTION.DOWN, directionalScore: 20, models: {} },
        outcome: {
          firstBarrier050: i % 3 === 0 ? "NEITHER" : i % 2 ? "UP_FIRST" : "DOWN_FIRST",
          return15m: 0.001,
          MFE: 0.002,
          MAE: 0.001,
        },
        features: { normalized: {} },
        context: {},
      });
    }
    return rows;
  }

  it("keeps TEST after TRAIN and VALIDATION with no overlap", () => {
    const split = timeSplits(fakeRows(100), { train: 0.6, validation: 0.2, test: 0.2 });
    assert.equal(split.TRAIN.sampleCount + split.VALIDATION.sampleCount + split.TEST.sampleCount, 100);
    assert.ok(split.ranges.TRAIN.to <= split.ranges.VALIDATION.from);
    assert.ok(split.ranges.VALIDATION.to <= split.ranges.TEST.from);
  });

  it("walk-forward test windows never overlap their train windows", () => {
    const wf = walkForward(fakeRows(500), { trainSec: 60 * 60, testSec: 20 * 60 });
    assert.ok(wf.folds.length >= 1);
    for (const f of wf.folds) {
      assert.ok(f.test.from >= f.train.to);
      assert.ok(f.test.to > f.test.from);
    }
  });

  it("does not claim an edge from tiny samples", () => {
    const s = summarizeRows(fakeRows(12));
    assert.equal(s.insufficient, true);
    assert.equal(s.overallHitRate.label, "INSUFFICIENT DATA");
    assert.equal(s.overallHitRate.n, s.directionalCount);
  });
});

describe("engine sequential backtest", () => {
  it("freezes features at T and labels only the next 15 minutes", () => {
    const rows = [];
    let price = 100;
    for (let i = 0; i <= 120; i++) {
      const t = i * 15;
      if (i > 4 && i < 20) price = 100.6;
      else if (i >= 20) price = 99.4;
      else price = 100;
      rows.push({
        t,
        live: {
          ts: t * 1000,
          symbol: "BTCUSDT",
          ready: true,
          price,
          preMove: {
            current: {
              upPressure: 80,
              downPressure: 20,
              confidence: 70,
              state: "UPSIDE_PRESSURE_BUILDING",
              features: {
                AggressiveBuyPower: 80,
                AggressiveSellPower: 20,
                PassiveSellerDefense: 25,
                PassiveBuyerDefense: 70,
                AskCancellation: 75,
                BidCancellation: 20,
                AskReplenishment: 20,
                BidReplenishment: 70,
                AskConsumption: 70,
                BidConsumption: 20,
                AskSurvival: 25,
                BidSurvival: 70,
                UpPressure: 80,
                DownPressure: 20,
              },
              raw: { buyVol: 10, sellVol: 2, bookImbalance: 0.2, askCancel: 1, bidCancel: 0.1 },
              dataQuality: { trades: "OK", book: "OK" },
              UpsideBattleSpread: 40,
              DownsideBattleSpread: -20,
              upVelocity: 5,
              downVelocity: -2,
              upAcceleration: 3,
              downAcceleration: -1,
            },
          },
          battlesByWindow: { 60: { buy: { state: "BALANCED" }, sell: { state: "BALANCED" } } },
          flowWindows: { 60: { aggressiveBuyVolume: 10, aggressiveSellVolume: 2 } },
          liqWindows: { 60: {} },
        },
      });
    }
    const engine = runBacktest(rows, { sampleIntervalSec: 0, minSamples: 5 });
    assert.ok(engine.completed.length > 0);
    const first = engine.completed[0];
    assert.equal(first.strategyVersion, STRATEGY_PREMOVE_V1_0.version);
    assert.ok(first.features.normalized.AggressiveBuyPower === 80);
    assert.equal(first.outcome.tickCount > 0, true);
    const laterNorm = engine.completed[engine.completed.length - 1].features.normalized;
    assert.equal(first.features.normalized.AggressiveBuyPower, 80);
    assert.ok(laterNorm);
  });
});

describe("outcomes are never labelled from data the engine did not observe", () => {
  function busyEngine(maxTicks) {
    const eng = new PathTestEngine({ sampleIntervalSec: 1e9, maxTicks });
    const t0 = 1_000_000;
    eng.pushPrice(t0, 100);
    eng.open.push({
      id: "x",
      timestamp: t0,
      timestampMs: t0 * 1000,
      price: 100,
      prediction: { label: PREDICTION.UP },
    });
    for (let s = 1; s <= 900; s++) {
      for (let k = 0; k < 40; k++) {
        eng.pushPrice(t0 + s + k / 40, s < 120 ? 100 + 1.2 * (s / 120) : 100.02);
      }
    }
    eng._resolveOpen(t0 + 901);
    return eng;
  }

  it("discards a row whose early path was trimmed instead of mislabelling it", () => {
    const eng = busyEngine(24_000);
    assert.equal(eng.completed.length, 0);
    assert.equal(eng.dropped.uncoveredTicks, 1);
  });

  it("labels the same path correctly when the tick buffer covers the horizon", () => {
    const eng = busyEngine(250_000);
    assert.equal(eng.completed.length, 1);
    const o = eng.completed[0].outcome;
    assert.equal(o.firstBarrier050, FIRST_BARRIER.UP_FIRST);
    assert.ok(o.maxUp15m > 0.011);
    assert.equal(o.coverage, "FULL");
  });

  it("keeps end-of-data rows pending rather than labelling a partial path", () => {
    const rows = [];
    for (let i = 0; i <= 100; i++) {
      const t = 2_000_000 + i * 15;
      rows.push({ t, live: { ts: t * 1000, symbol: "X", ready: true, price: 100, preMove: { current: {} } } });
    }
    const eng = runBacktest(rows, { minSamples: 5 });
    assert.ok(eng.open.length > 0, "tail rows must stay open");
    for (const r of eng.completed) {
      const lastTick = eng.ticks[eng.ticks.length - 1].t;
      assert.ok(lastTick >= r.timestamp + eng.horizonSec);
    }
  });

  it("flags a path with a large hole as GAPPY and excludes it from metrics", () => {
    const t0 = 0;
    const out = labelPath({
      t0,
      priceAtT: 100,
      ticks: [
        { t: 10, price: 100.1 },
        { t: 880, price: 100.2 },
      ],
      now: 900,
      prediction: PREDICTION.UP,
    });
    assert.equal(out.coverage, "GAPPY");
    assert.ok(out.maxGapSec > 800);
    const s = summarizeRows([
      { timestamp: t0, prediction: { label: PREDICTION.UP }, outcome: out, features: {}, context: {} },
    ]);
    assert.equal(s.sampleCount, 0);
    assert.equal(s.excludedGappy, 1);
  });
});

describe("baselines point the right way", () => {
  it("BUY_SELL_DELTA_ONLY follows the sign of the delta, not the percentile magnitude", () => {
    const low = scoreBaselines({ BuySellDelta: 10 }, { id: "a" }).BUY_SELL_DELTA_ONLY;
    const mid = scoreBaselines({ BuySellDelta: 50 }, { id: "a" }).BUY_SELL_DELTA_ONLY;
    const high = scoreBaselines({ BuySellDelta: 90 }, { id: "a" }).BUY_SELL_DELTA_ONLY;
    assert.equal(low.prediction, PREDICTION.DOWN);
    assert.equal(mid.prediction, PREDICTION.NO_EDGE);
    assert.equal(high.prediction, PREDICTION.UP);
  });
});

describe("overlapping windows are not counted as independent", () => {
  it("shrinks the effective sample size and widens the interval", () => {
    const rows = [];
    for (let i = 0; i < 240; i++) {
      rows.push({
        timestamp: i * 15,
        prediction: { label: PREDICTION.UP, directionalScore: 40, models: {} },
        outcome: {
          horizonSec: 900,
          coverage: "FULL",
          firstBarrier050: i % 2 ? "UP_FIRST" : "DOWN_FIRST",
          return15m: 0.001,
          MFE: 0.002,
          MAE: 0.001,
        },
        features: { normalized: {} },
        context: {},
      });
    }
    const s = summarizeRows(rows);
    assert.equal(s.independence.overlapFactor, 60);
    assert.equal(s.overallHitRate.n, 240);
    assert.equal(s.overallHitRate.nEff, 4);
    const width = s.overallHitRate.ci.hi - s.overallHitRate.ci.lo;
    assert.ok(width > 0.5, `interval should stay wide, got ${width}`);
    assert.equal(s.insufficient, true);
  });
});

describe("recorded signals survive a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pathtest-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function feed(engine, base, count) {
    for (let i = 0; i < count; i++) {
      const t = base + i * 15;
      engine.observe(
        {
          ts: t * 1000,
          symbol: "SOLUSDT",
          ready: true,
          price: 100 + Math.sin(i / 3) * 0.9,
          preMove: {
            current: {
              upPressure: 80,
              downPressure: 15,
              confidence: 70,
              state: "UPSIDE_PRESSURE_BUILDING",
              features: { AggressiveBuyPower: 85, AggressiveSellPower: 15 },
              raw: { buyVol: 10, sellVol: 2 },
              dataQuality: { trades: "OK", book: "OK" },
            },
          },
          battlesByWindow: {},
          flowWindows: {},
          liqWindows: {},
        },
        { now: t }
      );
    }
  }

  it("writes snapshots and outcomes, then reloads only labelled rows", () => {
    const base = 1_700_000_000;
    const first = new PathTestEngine({ symbol: "SOLUSDT", persist: true, dataDir: dir });
    feed(first, base, 120);
    const labelled = first.completed.length;
    const pending = first.open.length;
    first.close();

    assert.ok(labelled > 0, "some rows should have completed");
    assert.ok(pending > 0, "some rows should still be open");

    const second = new PathTestEngine({ symbol: "SOLUSDT", persist: true, dataDir: dir });
    const restored = second.hydrate();
    assert.equal(restored.completed, labelled, "labelled rows come back");
    assert.equal(restored.abandoned, pending, "mid-horizon rows are counted, not resurrected");
    assert.equal(second.completed.length, labelled);
    assert.equal(second.open.length, 0);
    second.close();
  });

  it("keeps versions in separate files and replays them", () => {
    const base = 1_710_000_000;
    const eng = new PathTestEngine({ symbol: "AVAXUSDT", persist: true, dataDir: dir });
    feed(eng, base, 120);
    eng.close();

    const file = path.join(dir, "AVAXUSDT__PREMOVE_V1.0.jsonl");
    assert.ok(fs.existsSync(file), "file is named by symbol and version");

    const recorded = replayRowsFromFile(file);
    assert.ok(recorded.length > 0);
    for (let i = 1; i < recorded.length; i++) {
      assert.ok(recorded[i].timestamp >= recorded[i - 1].timestamp, "replay rows are ordered");
    }

    const { rows } = rescoreRecorded(recorded, getStrategy("PREMOVE_V1.0"));
    assert.equal(rows.length, eng.completed.length);
    // Re-scoring frozen features must reproduce the live prediction exactly.
    for (const row of rows) {
      const live = eng.completed.find((r) => r.id === row.id);
      assert.equal(row.prediction.label, live.prediction.label);
      assert.equal(row.prediction.directionalScore, live.prediction.directionalScore);
    }
  });

  it("never writes to disk during a replay", () => {
    const before = fs.readdirSync(dir).length;
    const rows = [];
    for (let i = 0; i <= 80; i++) {
      const t = 1_720_000_000 + i * 15;
      rows.push({ t, live: { ts: t * 1000, symbol: "Z", ready: true, price: 100, preMove: { current: {} } } });
    }
    const eng = runBacktest(rows);
    assert.equal(eng.store, null);
    assert.equal(fs.readdirSync(dir).length, before);
  });
});

describe("stop/target economics from recorded barrier times", () => {
  function row(pred, times, extra = {}) {
    return {
      timestamp: (row.n = (row.n || 0) + 1) * 900, // non-overlapping
      prediction: { label: pred, directionalScore: pred === PREDICTION.UP ? 40 : -40, models: {} },
      features: { normalized: {} },
      context: {},
      outcome: {
        horizonSec: 900,
        coverage: "FULL",
        return15m: 0,
        maxUp15m: 0.006,
        maxDown15m: -0.006,
        MFE: 0.006,
        MAE: 0.006,
        TimeToUp025: null,
        TimeToDown025: null,
        TimeToUp050: null,
        TimeToDown050: null,
        TimeToUp100: null,
        TimeToDown100: null,
        ...times,
        ...extra,
      },
    };
  }

  it("counts a win only when the target is reached before the stop", () => {
    const rows = [
      // long: +0.50% at 100s, -0.25% at 300s -> target first
      row(PREDICTION.UP, { TimeToUp050: 100, TimeToDown025: 300, firstBarrier050: "UP_FIRST" }),
      // long: -0.25% at 50s, +0.50% at 200s -> stopped before the target
      row(PREDICTION.UP, { TimeToUp050: 200, TimeToDown025: 50, firstBarrier050: "UP_FIRST" }),
    ];
    const grid = barrierGrid(rows, { minSamples: 1 });
    const tight = grid.find((g) => g.stop === 0.0025 && g.target === 0.005);
    assert.equal(tight.wins, 1);
    assert.equal(tight.losses, 1);
    assert.equal(tight.winRate.value, 0.5);

    // Same signals with a wider stop: neither is stopped out.
    const wide = grid.find((g) => g.stop === 0.005 && g.target === 0.005);
    assert.equal(wide.wins, 2);
    assert.equal(wide.losses, 0);
  });

  it("a tie resolves against the trade", () => {
    const rows = [row(PREDICTION.UP, { TimeToUp050: 120, TimeToDown050: 120, firstBarrier050: "UP_FIRST" })];
    const g = barrierGrid(rows, { minSamples: 1 }).find((x) => x.stop === 0.005 && x.target === 0.005);
    assert.equal(g.wins, 0);
    assert.equal(g.losses, 1);
  });

  it("neither barrier touched is a timeout, not a loss", () => {
    const rows = [row(PREDICTION.UP, { firstBarrier050: "NEITHER" }, { return15m: 0.001 })];
    const g = barrierGrid(rows, { minSamples: 1 }).find((x) => x.stop === 0.005 && x.target === 0.005);
    assert.equal(g.timeouts, 1);
    assert.equal(g.wins + g.losses, 0);
    assert.ok(Math.abs(g.expectancyR - 0.2) < 1e-9, "timeout scores return/stop in R");
  });

  it("the symmetric cell reproduces the first-barrier hit rate", () => {
    const rows = [
      row(PREDICTION.UP, { TimeToUp050: 100, firstBarrier050: "UP_FIRST" }),
      row(PREDICTION.UP, { TimeToDown050: 100, firstBarrier050: "DOWN_FIRST" }),
      row(PREDICTION.DOWN, { TimeToDown050: 100, firstBarrier050: "DOWN_FIRST" }),
      row(PREDICTION.UP, { firstBarrier050: "NEITHER" }),
    ];
    const g = barrierGrid(rows, { minSamples: 1 }).find((x) => x.stop === 0.005 && x.target === 0.005);
    const s = summarizeRows(rows, { minSamples: 1 });
    assert.equal(g.winRate.value, s.overallHitRate.value);
  });

  it("reports the adverse excursion tail of winning signals", () => {
    const rows = [];
    for (const mae of [0.001, 0.002, 0.003, 0.004, 0.005]) {
      rows.push(row(PREDICTION.UP, { TimeToUp050: 60, firstBarrier050: "UP_FIRST" }, { MAE: mae, timeToTarget: 60 }));
    }
    rows.push(row(PREDICTION.UP, { firstBarrier050: "DOWN_FIRST" }, { MAE: 0.02 }));
    const ex = excursionStats(rows, { minSamples: 1 });
    assert.equal(ex.winners.count, 5);
    assert.equal(ex.losers.count, 1, "losers are kept separate");
    assert.equal(ex.winners.MAE.p50, 0.003);
    // p90 of the winners drives stop placement, not the mean.
    assert.ok(ex.suggestedStop > 0.004 && ex.suggestedStop <= 0.005);
  });
});

describe("state mapping stays categorical", () => {
  it("maps known engine states without ordinal numbers", () => {
    assert.equal(
      mapEngineState({
        battleBuy: "BUYERS_WINNING",
        battleSell: "BALANCED",
        preMoveState: "STRONG_UPSIDE_PRESSURE",
        confidence: 80,
      }),
      "BUYERS_WINNING"
    );
    assert.equal(
      mapEngineState({
        battleBuy: "LOW_CONFIDENCE",
        battleSell: "BUYERS_WINNING",
        preMoveState: "STRONG_UPSIDE_PRESSURE",
        confidence: 90,
      }),
      "LOW_CONFIDENCE"
    );
  });
});

describe("optional crypto fields stay null when missing", () => {
  it("scoreSnapshot does not treat missing futures fields as zero", () => {
    const scored = scoreSnapshot({
      AggressiveBuyPower: 60,
      AggressiveSellPower: 40,
      UpPressure: 60,
      DownPressure: 40,
      Confidence: 50,
      OpenInterest: null,
      FundingRate: null,
    });
    assert.equal(scored.full.confidence, 50);
    assert.notEqual(scored.full.directionalScore, null);
  });
});
