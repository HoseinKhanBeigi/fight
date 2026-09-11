#!/usr/bin/env node
/**
 * Replay recorded snapshots through a frozen strategy version.
 *
 *   npm run backtest -- data/path-test/SOLUSDT__PREMOVE_V1.0.jsonl
 *   npm run backtest -- <file> --version PREMOVE_V1.1
 *
 * Predictions are re-derived from the features frozen at T, so a new weight set
 * can be scored against identical inputs. Path outcomes are reused as recorded
 * (they were measured at tick resolution and do not depend on the formula);
 * only MFE/MAE orientation, which follows the predicted direction, is redone.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { replayRowsFromFile } from "./store.js";
import { scoreSnapshot } from "./scores.js";
import { getStrategy } from "./strategy.js";
import {
  ablationReport,
  barrierGrid,
  comparisonTable,
  confidenceBuckets,
  correlationReport,
  excursionStats,
  scoreBuckets,
  summarizeRows,
  timeSplits,
  walkForward,
} from "./metrics.js";
import { PREDICTION } from "./constants.js";

/** Re-point MFE/MAE at the direction this strategy actually predicted. */
function reorientOutcome(outcome, prediction) {
  const up = outcome.maxUp15m;
  const down = outcome.maxDown15m;
  if (!Number.isFinite(up) || !Number.isFinite(down)) return outcome;
  if (prediction === PREDICTION.DOWN) {
    return {
      ...outcome,
      MFE: -down,
      MAE: Math.abs(up),
      maeMfeBasis: "BEARISH",
      timeToTarget: outcome.TimeToDown050 ?? null,
    };
  }
  if (prediction === PREDICTION.UP) {
    return {
      ...outcome,
      MFE: up,
      MAE: Math.abs(down),
      maeMfeBasis: "BULLISH",
      timeToTarget: outcome.TimeToUp050 ?? null,
    };
  }
  return { ...outcome, MFE: up, MAE: Math.abs(down), maeMfeBasis: "UNSIGNED", timeToTarget: null };
}

/**
 * @param {object[]} recorded snapshot rows from disk, ascending by timestamp
 * @param {object} strategy frozen strategy definition
 */
export function rescoreRecorded(recorded, strategy = getStrategy()) {
  const rows = [];
  let unlabelled = 0;
  for (const r of recorded) {
    if (!r.outcome) {
      unlabelled += 1;
      continue;
    }
    const normalized = r.features?.normalized;
    if (!normalized) continue;
    const scored = scoreSnapshot(
      normalized,
      {
        id: r.id,
        timestamp: r.timestamp,
        last15mReturn: r.context?.last15mReturn ?? normalized.last15mReturn,
      },
      strategy
    );
    rows.push({
      ...r,
      strategyVersion: strategy.version,
      prediction: {
        ...r.prediction,
        upsideScore: scored.full.upsideScore,
        downsideScore: scored.full.downsideScore,
        directionalScore: scored.full.directionalScore,
        finalDirectionalStrength: scored.full.finalDirectionalStrength,
        label: scored.full.prediction,
        models: Object.fromEntries(
          Object.entries(scored.models).map(([k, v]) => [
            k,
            { prediction: v.prediction, directionalScore: v.directionalScore },
          ])
        ),
      },
      outcome: reorientOutcome(r.outcome, scored.full.prediction),
    });
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return { rows, unlabelled };
}

export function report(rows, strategy) {
  const minSamples = strategy.thresholds.minSamples;
  return {
    full: summarizeRows(rows, { minSamples }),
    comparison: comparisonTable(rows, minSamples),
    scoreBuckets: scoreBuckets(rows),
    confidenceBuckets: confidenceBuckets(rows),
    ablation: ablationReport(rows, strategy),
    correlation: correlationReport(rows),
    excursions: excursionStats(rows, { minSamples }),
    barrierGrid: barrierGrid(rows, { minSamples }),
    splits: timeSplits(rows),
    walkForward: walkForward(rows),
  };
}

function pct(rate) {
  if (!rate || rate.value == null) return "INSUFFICIENT DATA";
  const ci =
    rate.ci?.lo != null ? ` [${(rate.ci.lo * 100).toFixed(0)}-${(rate.ci.hi * 100).toFixed(0)}]` : "";
  const flag = rate.label ? "  (INSUFFICIENT)" : "";
  return `${(rate.value * 100).toFixed(1).padStart(5)}%  n=${String(rate.n).padStart(5)} eff=${String(rate.nEff).padStart(4)}${ci}${flag}`;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node src/path-test/replay.js <file.jsonl> [--version PREMOVE_V1.0]");
    process.exit(1);
  }
  const vIndex = process.argv.indexOf("--version");
  const strategy = getStrategy(vIndex > 0 ? process.argv[vIndex + 1] : "PREMOVE_V1.0");

  const recorded = replayRowsFromFile(path.resolve(file));
  if (!recorded.length) {
    console.error("No snapshot rows found in", file);
    process.exit(1);
  }
  const { rows, unlabelled } = rescoreRecorded(recorded, strategy);
  if (!rows.length) {
    console.error(
      `Found ${recorded.length} snapshots but none have a 15m outcome yet. Let the recorder run longer.`
    );
    process.exit(1);
  }

  const rep = report(rows, strategy);
  const d = rep.full;
  const from = new Date(rows[0].timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
  const to = new Date(rows[rows.length - 1].timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);

  console.log(`\nBACKTEST  ${strategy.version}  ${rows[0].symbol || ""}`);
  console.log(`Window    ${from} -> ${to} UTC`);
  console.log(
    `Rows      ${recorded.length} recorded - ${d.sampleCount} labelled - ${unlabelled} awaiting outcome`
  );
  if (d.independence?.overlapFactor > 1) {
    console.log(
      `Overlap   ~${d.independence.overlapFactor}x (spacing ${d.independence.spacingSec}s) -> ${d.independence.effectiveSampleCount} independent windows`
    );
  }
  if (d.excludedGappy) console.log(`Excluded  ${d.excludedGappy} rows with a gap in the price path`);

  console.log(`\nFirst barrier +/-0.50% over 15m`);
  console.log(`  UP_FIRST     ${pct(d.UP_FIRST)}`);
  console.log(`  DOWN_FIRST   ${pct(d.DOWN_FIRST)}`);
  console.log(`  NEITHER      ${pct(d.NEITHER)}`);
  console.log(`  hit rate     ${pct(d.overallHitRate)}`);
  console.log(`  excl NEITHER ${pct(d.hitRateExNeither)}`);

  console.log(`\nModel comparison`);
  for (const row of rep.comparison) {
    console.log(`  ${row.model.padEnd(26)} ${pct(row.hitRate)}`);
  }

  console.log(`\nOut-of-sample (TEST held out)`);
  for (const key of ["TRAIN", "VALIDATION", "TEST"]) {
    console.log(`  ${key.padEnd(12)} ${pct(rep.splits[key]?.overallHitRate)}`);
  }

  if (rep.ablation.length) {
    console.log(`\nAblation (delta vs full, percentage points)`);
    for (const a of rep.ablation) {
      const delta = a.deltaVsFull == null ? "  n/a" : (a.deltaVsFull * 100).toFixed(1).padStart(5);
      console.log(`  ${a.group.padEnd(22)} ${delta}  ${a.effect}`);
    }
  }
  const ex = rep.excursions;
  if (ex.winners.count) {
    const f = (v) => (v == null ? "  n/a" : `${(v * 100).toFixed(3)}%`);
    console.log(`\nAdverse excursion before a signal worked  (n=${ex.winners.count} winners)`);
    console.log(
      `  MAE p50 ${f(ex.winners.MAE.p50)}  p75 ${f(ex.winners.MAE.p75)}  p90 ${f(ex.winners.MAE.p90)}  p95 ${f(ex.winners.MAE.p95)}  max ${f(ex.winners.MAE.max)}`
    );
    console.log(
      `  A stop tighter than ${f(ex.suggestedStop)} would have cut off 10% of the signals that worked.${
        ex.insufficient ? "  (INSUFFICIENT)" : ""
      }`
    );
    if (ex.winners.timeToTarget.p50 != null) {
      console.log(
        `  Time to target p50 ${ex.winners.timeToTarget.p50.toFixed(0)}s  p90 ${ex.winners.timeToTarget.p90.toFixed(0)}s`
      );
    }
  }

  const grid = rep.barrierGrid.filter((g) => g.n > 0);
  if (grid.length) {
    console.log(`\nStop / target grid  (target reached before stop, ties lose)`);
    console.log(`  stop   target   R:R   win rate                              expectancy`);
    for (const g of grid) {
      const wr = g.winRate.value == null ? "    n/a" : `${(g.winRate.value * 100).toFixed(1).padStart(5)}%`;
      const exp = g.expectancyR == null ? " n/a" : `${g.expectancyR >= 0 ? "+" : ""}${g.expectancyR.toFixed(2)}R`;
      console.log(
        `  ${(g.stop * 100).toFixed(2)}%  ${(g.target * 100).toFixed(2)}%  ${g.rr.toFixed(1).padStart(4)}   ${wr}  W${String(g.wins).padStart(4)} L${String(g.losses).padStart(4)} T${String(g.timeouts).padStart(4)}  ${exp}${g.insufficient ? "  (INSUFFICIENT)" : ""}`
      );
    }
  }

  if (rep.correlation.redundant.length) {
    console.log(`\nRedundant features |r| >= 0.80`);
    for (const p of rep.correlation.redundant.slice(0, 10)) {
      console.log(`  ${p.a} <-> ${p.b}  ${p.r.toFixed(2)}`);
    }
  }
  console.log("");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
