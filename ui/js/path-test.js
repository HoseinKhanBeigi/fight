/**
 * Forward Test dashboard + signal log (display only).
 * Does not alter engine scoring.
 */

function fmtPct(x, digits = 2) {
  if (x == null || Number.isNaN(Number(x))) return "—";
  const v = Number(x) * 100;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtScore(x) {
  if (x == null || Number.isNaN(Number(x))) return "—";
  const v = Math.round(Number(x));
  return v > 0 ? `+${v}` : String(v);
}

function fmtN(n) {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

function rateCell(rate) {
  if (!rate || rate.n == null) return `<span class="pt-insuf">INSUFFICIENT DATA</span>`;
  // Overlapping 15m windows: nEff is the independent count the interval uses.
  const eff =
    rate.nEff != null && rate.nEff !== rate.n ? ` eff=${fmtN(rate.nEff)}` : "";
  const n = `<small title="raw samples / independent samples">n=${fmtN(rate.n)}${eff}</small>`;
  if (rate.label === "INSUFFICIENT DATA" || rate.value == null) {
    return `<span class="pt-insuf">INSUFFICIENT DATA ${n}</span>`;
  }
  const pct = `${(rate.value * 100).toFixed(1)}%`;
  const ci =
    rate.ci?.lo != null
      ? `<em title="95% interval on independent samples">${(rate.ci.lo * 100).toFixed(0)}–${(rate.ci.hi * 100).toFixed(0)}</em>`
      : "";
  return `<b>${pct}</b> ${n} ${ci}`;
}

function clock(ts) {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function predClass(p) {
  if (p === "UP") return "up";
  if (p === "DOWN") return "down";
  return "flat";
}

function outcomeMark(row) {
  if (row.pending) return `<span class="pt-pending">pending 15m</span>`;
  if (!row.outcome) return "—";
  const ok = row.correct === true;
  const bad = row.correct === false;
  const mark = ok ? "✓" : bad ? "✕" : "·";
  return `<span class="${ok ? "ok" : bad ? "bad" : ""}">${row.outcome} ${mark}</span>`;
}

export function renderPathTest(host, data) {
  if (!host) return;
  if (!data) {
    host.innerHTML = `<div class="pt-empty">Forward test waiting for live snapshots.</div>`;
    return;
  }
  const openMore = host.querySelector(".pt-more")?.open === true;
  const d = data.dashboard || {};
  const acc = rateCell(d.currentForwardAccuracy);
  host.innerHTML = `
    <div class="pt-wrap">
      <div class="pt-toolbar">
        <div class="pt-title">Forward test</div>
        <div class="pt-ver">${d.strategyVersion || data.strategyVersion || "PREMOVE_V1.0"}</div>
        <div class="pt-mode">${d.mode || "FORWARD"} · 15m first-barrier</div>
      </div>
      <div class="pt-kpis">
        <div class="pt-kpi"><span>Signals today</span><b>${fmtN(d.signalsToday)}</b></div>
        <div class="pt-kpi"><span>Signals total</span><b>${fmtN(d.signalsTotal)}</b></div>
        <div class="pt-kpi up"><span>UP</span><b>${fmtN(d.predictions?.UP)}</b></div>
        <div class="pt-kpi down"><span>DOWN</span><b>${fmtN(d.predictions?.DOWN)}</b></div>
        <div class="pt-kpi"><span>NO_EDGE</span><b>${fmtN(d.predictions?.NO_EDGE)}</b></div>
        <div class="pt-kpi"><span>Sample size</span><b>${fmtN(d.sampleSize)}</b></div>
      </div>
      <div class="pt-acc">
        <div class="pt-acc-row"><span>Forward accuracy</span>${acc}</div>
        <div class="pt-acc-row"><span>UP_FIRST</span>${rateCell(d.UP_FIRST)}</div>
        <div class="pt-acc-row"><span>DOWN_FIRST</span>${rateCell(d.DOWN_FIRST)}</div>
        <div class="pt-acc-row"><span>NEITHER</span>${rateCell(d.NEITHER)}</div>
        <div class="pt-acc-row"><span>Avg MFE</span><b>${fmtPct(d.averageMFE)}</b></div>
        <div class="pt-acc-row"><span>Avg MAE</span><b>${fmtPct(d.averageMAE)}</b></div>
        <div class="pt-acc-row"><span>Open</span><b>${fmtN(d.openCount)}</b></div>
      </div>
      ${renderQuality(d)}
      ${renderLog(data.log)}
      <details class="pt-more">
        <summary>Analysis — stops, baselines, buckets, regime, ablation, OOS</summary>
        ${renderExcursions(data.excursions)}
        ${renderGrid(data.barrierGrid)}
        ${renderComparison(data.comparison)}
        ${renderBuckets("Score buckets |DirectionalScore|", data.scoreBuckets)}
        ${renderBuckets("Confidence buckets", data.confidenceBuckets)}
        ${renderRegimes(data.regimes)}
        ${renderSessions(data.sessions)}
        ${renderAblation(data.ablation)}
        ${renderCorr(data.correlation)}
        ${renderSplits(data.splits, data.walkForward)}
      </details>
    </div>
  `;
  const more = host.querySelector(".pt-more");
  if (more) more.open = openMore;
}

function renderQuality(d) {
  const ind = d.independence;
  const drop = d.dropped || {};
  const bits = [];
  if (ind?.overlapFactor > 1) {
    bits.push(
      `Samples overlap ~${ind.overlapFactor}× (one 15m window every ${ind.spacingSec ?? "—"}s), so ${fmtN(d.sampleSize)} labels ≈ <b>${fmtN(ind.effectiveSampleCount)}</b> independent observations.`
    );
  }
  if (d.excludedGappy) bits.push(`${fmtN(d.excludedGappy)} excluded (gap in path).`);
  if (drop.uncoveredTicks) bits.push(`${fmtN(drop.uncoveredTicks)} discarded (tick history trimmed).`);
  if (drop.overflow) bits.push(`${fmtN(drop.overflow)} discarded (open-signal overflow).`);
  if (!bits.length) return "";
  return `<div class="pt-quality">${bits.join(" ")}</div>`;
}

function renderExcursions(ex) {
  if (!ex?.winners?.count) return "";
  const w = ex.winners;
  const f = (v) => (v == null ? "—" : `${(v * 100).toFixed(3)}%`);
  const secs = (v) => (v == null ? "—" : `${v.toFixed(0)}s`);
  return `
    <div class="pt-section">
      <div class="pt-h">Adverse excursion before a signal worked <small>n=${fmtN(w.count)} winners${
        ex.insufficient ? " · INSUFFICIENT" : ""
      }</small></div>
      <table class="pt-table">
        <thead><tr><th></th><th>p50</th><th>p75</th><th>p90</th><th>p95</th><th>max</th></tr></thead>
        <tbody>
          <tr><td>MAE (against)</td><td>${f(w.MAE.p50)}</td><td>${f(w.MAE.p75)}</td><td>${f(w.MAE.p90)}</td><td>${f(w.MAE.p95)}</td><td>${f(w.MAE.max)}</td></tr>
          <tr><td>MFE (in favour)</td><td>${f(w.MFE.p50)}</td><td>${f(w.MFE.p75)}</td><td>${f(w.MFE.p90)}</td><td>${f(w.MFE.p95)}</td><td>${f(w.MFE.max)}</td></tr>
          <tr><td>Time to target</td><td>${secs(w.timeToTarget.p50)}</td><td>${secs(w.timeToTarget.p75)}</td><td>${secs(w.timeToTarget.p90)}</td><td>${secs(w.timeToTarget.p95)}</td><td>${secs(w.timeToTarget.max)}</td></tr>
        </tbody>
      </table>
      <div class="pt-quality">A stop tighter than <b>${f(ex.suggestedStop)}</b> would have cut off 10% of the signals that worked.</div>
    </div>`;
}

function renderGrid(grid) {
  const rows = (grid || []).filter((g) => g.n > 0);
  if (!rows.length) return "";
  return `
    <div class="pt-section">
      <div class="pt-h">Stop / target grid <small>target reached before stop · ties lose</small></div>
      <table class="pt-table">
        <thead><tr><th>Stop</th><th>Target</th><th>R:R</th><th>Win rate</th><th>W/L/T</th><th>Expectancy</th></tr></thead>
        <tbody>
          ${rows
            .map((g) => {
              const exp = g.expectancyR == null ? "—" : `${g.expectancyR >= 0 ? "+" : ""}${g.expectancyR.toFixed(2)}R`;
              const cls = g.expectancyR == null ? "" : g.expectancyR > 0 ? "pt-up" : "pt-down";
              return `<tr>
                <td>${(g.stop * 100).toFixed(2)}%</td>
                <td>${(g.target * 100).toFixed(2)}%</td>
                <td>${g.rr.toFixed(1)}</td>
                <td>${rateCell(g.winRate)}</td>
                <td><small>${g.wins}/${g.losses}/${g.timeouts}</small></td>
                <td class="${cls}">${exp}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderComparison(rows) {
  if (!rows?.length) return "";
  return `
    <div class="pt-section">
      <div class="pt-h">Baseline comparison</div>
      <table class="pt-table">
        <thead><tr><th>Model</th><th>N</th><th>Hit rate</th><th>UP_FIRST</th><th>DOWN_FIRST</th><th>NEITHER</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
                <td>${r.model.replaceAll("_", " ")}</td>
                <td>${fmtN(r.n)}</td>
                <td>${rateCell(r.hitRate)}</td>
                <td>${rateCell(r.UP_FIRST)}</td>
                <td>${rateCell(r.DOWN_FIRST)}</td>
                <td>${rateCell(r.NEITHER)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderBuckets(title, rows) {
  if (!rows?.length) return "";
  return `
    <div class="pt-section">
      <div class="pt-h">${title}</div>
      <table class="pt-table">
        <thead><tr><th>Bucket</th><th>N</th><th>UP_FIRST</th><th>DOWN_FIRST</th><th>NEITHER</th><th>Avg ret</th><th>MFE</th><th>MAE</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
                <td>${r.id}</td>
                <td>${fmtN(r.sampleCount)}</td>
                <td>${rateCell(r.UP_FIRST)}</td>
                <td>${rateCell(r.DOWN_FIRST)}</td>
                <td>${rateCell(r.NEITHER)}</td>
                <td>${fmtPct(r.averageReturn15m)}</td>
                <td>${fmtPct(r.averageMFE)}</td>
                <td>${fmtPct(r.averageMAE)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderRegimes(regimes) {
  if (!regimes) return "";
  const keys = ["TREND", "RANGE", "COMPRESSION", "HIGH_VOLATILITY", "LOW_VOLATILITY"];
  return `
    <div class="pt-section">
      <div class="pt-h">Regime</div>
      <div class="pt-chips">
        ${keys
          .map((k) => {
            const s = regimes[k];
            return `<div class="pt-chip"><span>${k.replaceAll("_", " ")}</span>${rateCell(s?.overallHitRate)}<small>${fmtN(s?.sampleCount)} samples</small></div>`;
          })
          .join("")}
      </div>
    </div>`;
}

function renderSessions(sessions) {
  if (!sessions) return "";
  return `
    <div class="pt-section">
      <div class="pt-h">Session / hour</div>
      <div class="pt-chips">
        ${["ASIA", "EUROPE", "US"]
          .map((k) => `<div class="pt-chip"><span>${k}</span>${rateCell(sessions[k]?.overallHitRate)}<small>${fmtN(sessions[k]?.sampleCount)} samples</small></div>`)
          .join("")}
      </div>
    </div>`;
}

function renderAblation(rows) {
  if (!rows?.length) return "";
  return `
    <div class="pt-section">
      <div class="pt-h">Ablation (frozen formula, no weight fit)</div>
      <table class="pt-table">
        <thead><tr><th>Removed</th><th>N</th><th>Hit rate</th><th>vs full</th><th>Effect</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
                <td>${r.group}</td>
                <td>${fmtN(r.n)}</td>
                <td>${rateCell(r.hitRate)}</td>
                <td>${r.deltaVsFull == null ? "—" : `${(r.deltaVsFull * 100).toFixed(1)} pp`}</td>
                <td class="${r.effect === "HELPS" ? "ok" : r.effect === "HURTS" ? "bad" : ""}">${r.effect}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderCorr(corr) {
  const red = corr?.redundant || [];
  if (!red.length && !corr?.pairs?.length) return "";
  if (!red.length) {
    return `<div class="pt-section"><div class="pt-h">Feature redundancy</div><div class="pt-note">No pairs with |r| ≥ 0.80 yet.</div></div>`;
  }
  return `
    <div class="pt-section">
      <div class="pt-h">Redundant features |r| ≥ 0.80</div>
      <div class="pt-note">${red.map((p) => `${p.a} ↔ ${p.b} (${p.r.toFixed(2)})`).join(" · ")}</div>
    </div>`;
}

function renderSplits(splits, wf) {
  if (!splits) return "";
  const row = (name, s) =>
    `<tr><td>${name}</td><td>${fmtN(s?.sampleCount)}</td><td>${rateCell(s?.overallHitRate)}</td></tr>`;
  const folds = (wf?.folds || [])
    .map(
      (f, i) =>
        `<tr><td>WF ${i + 1} test</td><td>${fmtN(f.test?.n)}</td><td>${rateCell(f.testHit)}</td></tr>`
    )
    .join("");
  return `
    <div class="pt-section">
      <div class="pt-h">Out-of-sample (time split — TEST held out)</div>
      <table class="pt-table">
        <thead><tr><th>Split</th><th>N</th><th>Hit rate</th></tr></thead>
        <tbody>
          ${row("TRAIN 60%", splits.TRAIN)}
          ${row("VALIDATION 20%", splits.VALIDATION)}
          ${row("TEST 20%", splits.TEST)}
          ${folds}
        </tbody>
      </table>
    </div>`;
}

function renderLog(rows) {
  if (!rows?.length) {
    return `<div class="pt-section"><div class="pt-h">Signal log</div><div class="pt-note">No directional signals yet. Snapshots freeze every 15s after the feed is live.</div></div>`;
  }
  return `
    <div class="pt-section">
      <div class="pt-h">Signal log</div>
      <div class="pt-log">
        ${rows
          .map((r) => {
            return `<div class="pt-log-row ${predClass(r.prediction)}">
              <div class="pt-log-time">${clock(r.timestamp)}</div>
              <div class="pt-log-pred">${r.prediction} ${fmtScore(r.directionalScore)}</div>
              <div>px ${r.price != null ? Number(r.price).toFixed(4) : "—"}</div>
              <div>conf ${r.confidence ?? "—"}</div>
              <div>up ${r.UpPressure ?? "—"} / dn ${r.DownPressure ?? "—"}</div>
              <div>buy ${r.AggressiveBuyPower ?? "—"} def ${r.PassiveSellerDefense ?? "—"}</div>
              <div>spread ${fmtScore(r.UpsideBattleSpread != null ? (r.UpsideBattleSpread - 50) * 2 : null)}</div>
              <div>${outcomeMark(r)}</div>
              <div>${r.pending ? "" : `maxΔ ${fmtPct(r.maxUp15m)} / ${fmtPct(r.maxDown15m)}`}</div>
            </div>`;
          })
          .join("")}
      </div>
    </div>`;
}
