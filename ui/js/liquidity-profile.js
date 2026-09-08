/**
 * Passive Liquidity Profile / Liquidity Defense Shape (display-only).
 *
 * Visualizes existing Market Battle passive metrics as two separate radar shapes:
 *   PASSIVE SELLERS / ASKS
 *   PASSIVE BUYERS / BIDS
 *
 * Axes (normalized 0–100 from rolling percentiles already on the battle card):
 *   Replenishment · Survival · Cancellation · Consumption
 *
 * Absorption is a RESPONSE result — shown outside the shape, never as an axis.
 * Does NOT modify battle scoring, raw liquidity math, or signal logic.
 */

export const PROFILE_PAINT_MS = 750;
export const PROFILE_EMA_TAU_SEC = 2.5;
export const PROFILE_HIST_KEEP_MS = 900_000;
export const PROFILE_PREV_WINDOWS = [
  { sec: 5, label: "5s" },
  { sec: 10, label: "10s" },
  { sec: 30, label: "30s" },
  { sec: 60, label: "1m" },
];

// Canvas angles: 0 = right, π/2 = down, π = left, -π/2 = up
const AXES = [
  { key: "replenishment", label: "REPLENISHMENT", short: "Rep", angle: -Math.PI / 2 },
  { key: "cancellation", label: "CANCELLATION", short: "Can", angle: 0 },
  { key: "consumption", label: "CONSUMPTION", short: "Cons", angle: Math.PI / 2 },
  { key: "survival", label: "SURVIVAL", short: "Surv", angle: Math.PI },
];

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function emaStep(prev, next, dtSec, tau) {
  if (!Number.isFinite(next)) return prev;
  if (!Number.isFinite(prev)) return next;
  const a = 1 - Math.exp(-Math.max(dtSec, 0.05) / tau);
  return prev + a * (next - prev);
}

function pretty(state = "") {
  return String(state || "").replace(/_/g, " ");
}

function scoreLabel(n) {
  return Number.isFinite(n) ? String(Math.round(n)) : "—";
}

function signed(n) {
  if (!Number.isFinite(n)) return "—";
  const v = Math.round(n);
  return v > 0 ? `+${v}` : String(v);
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function pctOrdinal(n) {
  if (!Number.isFinite(n)) return "—";
  const v = Math.round(n);
  const mod10 = v % 10;
  const mod100 = v % 100;
  let suf = "th";
  if (mod10 === 1 && mod100 !== 11) suf = "st";
  else if (mod10 === 2 && mod100 !== 12) suf = "nd";
  else if (mod10 === 3 && mod100 !== 13) suf = "rd";
  return `${v}${suf}`;
}

function trendFromDelta(d) {
  if (!Number.isFinite(d)) return "STABLE";
  if (d >= 12) return "RISING_FAST";
  if (d >= 4) return "RISING";
  if (d <= -12) return "FALLING_FAST";
  if (d <= -4) return "FALLING";
  return "STABLE";
}

function emptySide(modelWindow) {
  return {
    modelWindow,
    side: null,
    lastTs: 0,
    quality: "NO_DATA",
    incomplete: true,
    raw: nullAxes(),
    display: nullAxes(),
    percentiles: nullAxes(),
    dollars: { replenishment: null, survival: null, cancellation: null, consumption: null },
    defense: null,
    absorption: null,
    attack: null,
    battleState: null,
    passiveState: null,
    profileState: "NO_DATA",
    confidence: null,
    deltas: nullAxes(),
    prev: null,
    hist: [],
  };
}

function nullAxes() {
  return {
    replenishment: null,
    survival: null,
    cancellation: null,
    consumption: null,
  };
}

export function createLiquidityProfileState() {
  return {
    prevLookback: 10,
    showAttack: true,
    showPrevious: true,
    paintAt: 0,
    hover: { side: null, axis: null },
    ask: emptySide(60),
    bid: emptySide(60),
  };
}

/**
 * Pull display inputs from an existing battle card.
 * Uses defense.features.* (already rolling-percentile 0–100). Never invents zeros.
 */
function readCardProfile(card, role) {
  if (!card) {
    return {
      quality: "NO_DATA",
      incomplete: true,
      axes: nullAxes(),
      percentiles: nullAxes(),
      dollars: { replenishment: null, survival: null, cancellation: null, consumption: null },
      defense: null,
      absorption: null,
      attack: null,
      battleState: null,
      passiveState: null,
      confidence: null,
    };
  }

  const f = card.defense?.features || {};
  const d = card.defense || {};
  const defQ = d.dataQuality || "OK";
  const atkQ = card.attack?.dataQuality || "OK";

  let quality = "OK";
  if (defQ === "NO_DATA" || card.state === "NO_DATA") quality = "NO_DATA";
  else if (defQ === "STALE" || card.state === "STALE") quality = "STALE";
  else if (defQ === "LOW_CONFIDENCE" || card.state === "LOW_CONFIDENCE") quality = "LOW_CONFIDENCE";

  const axes = {
    replenishment: Number.isFinite(f.replenishment) ? clamp(f.replenishment, 0, 100) : null,
    survival: Number.isFinite(f.survival) ? clamp(f.survival, 0, 100) : null,
    cancellation: Number.isFinite(f.cancellation) ? clamp(f.cancellation, 0, 100) : null,
    consumption: Number.isFinite(f.consumption) ? clamp(f.consumption, 0, 100) : null,
  };

  const missingAxis = AXES.some((a) => axes[a.key] == null);
  const incomplete = missingAxis || quality !== "OK";

  if (quality === "OK" && missingAxis) quality = "LOW_CONFIDENCE";

  const percentiles = {
    replenishment: Number.isFinite(d.refillPercentile) ? d.refillPercentile : axes.replenishment,
    survival: axes.survival,
    cancellation: Number.isFinite(d.cancelPercentile) ? d.cancelPercentile : axes.cancellation,
    consumption: Number.isFinite(d.consumePercentile) ? d.consumePercentile : axes.consumption,
  };

  const dollars = {
    replenishment: Number.isFinite(d.replenished) ? d.replenished : null,
    // Survival is a ratio score on the card, not a dollar notionals — expose as score.
    survival: Number.isFinite(d.survival) ? d.survival : null,
    cancellation: Number.isFinite(d.cancelled) ? d.cancelled : null,
    consumption: Number.isFinite(d.consumed) ? d.consumed : null,
  };

  const defense =
    role === "ask"
      ? d.PassiveSellerDefense ?? d.power ?? null
      : d.PassiveBuyerDefense ?? d.power ?? null;

  const absorption = Number.isFinite(card.response?.absorptionScore)
    ? clamp(card.response.absorptionScore, 0, 100)
    : null;

  const attack = Number.isFinite(card.attack?.power) ? clamp(card.attack.power, 0, 100) : null;

  // Confidence: share of ready axes + attack/defense readiness (display only).
  let ready = 0;
  let total = 4;
  for (const a of AXES) if (axes[a.key] != null) ready += 1;
  if (defense != null) {
    ready += 1;
    total += 1;
  }
  if (absorption != null) {
    ready += 1;
    total += 1;
  }
  const confidence =
    quality === "NO_DATA" || quality === "STALE" ? 0 : Math.round((ready / total) * 100);

  return {
    quality: atkQ === "NO_DATA" && quality === "OK" ? quality : quality,
    incomplete,
    axes,
    percentiles,
    dollars,
    defense: Number.isFinite(defense) ? clamp(defense, 0, 100) : null,
    absorption,
    attack: Number.isFinite(attack) ? attack : null,
    battleState: card.state || null,
    passiveState: card.passiveState || null,
    confidence,
  };
}

/**
 * Shape-level interpretation. Suppressed when inputs incomplete / low confidence.
 */
export function classifyProfileState(axes, deltas, quality, absorption, battleState) {
  if (quality === "NO_DATA") return "NO_DATA";
  if (quality === "STALE") return "STALE";
  if (quality === "LOW_CONFIDENCE" || !axes) return "LOW_CONFIDENCE";

  const r = axes.replenishment;
  const s = axes.survival;
  const c = axes.cancellation;
  const x = axes.consumption;
  if (![r, s, c, x].every(Number.isFinite)) return "LOW_CONFIDENCE";

  const high = (v) => v >= 70;
  const low = (v) => v <= 35;
  const mid = (v) => v > 35 && v < 70;

  // Prefer explicit absorption battle labels when absorption is strong.
  if (
    Number.isFinite(absorption) &&
    absorption >= 65 &&
    high(r) &&
    high(s) &&
    !high(c) &&
    (battleState === "SELLER_ABSORPTION" || battleState === "BUYER_ABSORPTION")
  ) {
    return battleState === "SELLER_ABSORPTION" ? "SELLER_ABSORPTION" : "BUYER_ABSORPTION";
  }

  const dR = deltas?.replenishment;
  const dS = deltas?.survival;
  const dC = deltas?.cancellation;
  const defenseUp =
    Number.isFinite(dR) &&
    Number.isFinite(dS) &&
    Number.isFinite(dC) &&
    dR >= 8 &&
    dS >= 4 &&
    dC <= -6;
  const defenseDown =
    Number.isFinite(dR) &&
    Number.isFinite(dS) &&
    Number.isFinite(dC) &&
    dR <= -8 &&
    dS <= -4 &&
    dC >= 6;

  if (high(c) && high(x) && low(r) && low(s)) return "DEFENSE_COLLAPSING";
  if (high(c) && low(r) && low(s)) return "LIQUIDITY_WITHDRAWING";
  if (defenseUp) return "DEFENSE_STRENGTHENING";
  if (defenseDown) return "DEFENSE_WEAKENING";
  if (high(x) && high(r) && high(s) && low(c)) return "ABSORBING_DEFENDING";
  if (high(r) && high(s) && low(c) && (mid(x) || high(x))) return "STRONG_DEFENSE";
  if (high(c) && c >= Math.max(r, s, x)) return "CANCELLATION_DOMINANT";
  if (high(r) && r >= Math.max(s, c, x) + 8) return "REPLENISHMENT_DOMINANT";
  if (high(x) && x >= Math.max(r, s, c) + 8) return "CONSUMPTION_DOMINANT";
  if (high(c) && high(r) && Math.abs(c - r) < 15) return "HIGH_CHURN";
  if (high(s) && s >= Math.max(r, c, x)) return "SURVIVAL_STRONG";
  if (low(s) && s <= Math.min(r, 100 - c, 100 - x)) return "SURVIVAL_WEAK";
  if (high(r) && mid(s) && !high(c)) return "MODERATE_DEFENSE";
  if (low(r) && low(s) && (high(c) || high(x))) return "WEAK_DEFENSE";
  if (mid(r) && mid(s) && !high(c)) return "MODERATE_DEFENSE";
  if (low(s) || high(c)) return "WEAK_DEFENSE";
  return "MODERATE_DEFENSE";
}

function snapshotAt(hist, lookbackSec, now) {
  if (!hist?.length) return null;
  const target = now - lookbackSec * 1000;
  let best = null;
  for (const row of hist) {
    if (row.t <= target) best = row;
    else break;
  }
  // Prefer a sample within 40% of the lookback window of the target.
  if (best && target - best.t <= lookbackSec * 1000 * 0.6) return best;
  // Fallback: oldest sample if still younger than 2× lookback.
  if (hist[0] && now - hist[0].t >= lookbackSec * 500) return hist[0];
  return best;
}

function axisDeltas(cur, prev) {
  const out = nullAxes();
  if (!cur || !prev) return out;
  for (const a of AXES) {
    if (Number.isFinite(cur[a.key]) && Number.isFinite(prev[a.key])) {
      out[a.key] = Math.round(cur[a.key] - prev[a.key]);
    }
  }
  return out;
}

function ingestSide(sideState, modelWindow, role, raw, now, lookbackSec) {
  if (sideState.modelWindow !== modelWindow) {
    Object.assign(sideState, emptySide(modelWindow));
  }
  sideState.side = role;
  sideState.quality = raw.quality;
  sideState.incomplete = raw.incomplete;
  sideState.raw = { ...raw.axes };
  sideState.percentiles = { ...raw.percentiles };
  sideState.dollars = { ...raw.dollars };
  sideState.defense = raw.defense;
  sideState.absorption = raw.absorption;
  sideState.attack = raw.attack;
  sideState.battleState = raw.battleState;
  sideState.passiveState = raw.passiveState;
  sideState.confidence = raw.confidence;

  const dtSec = sideState.lastTs ? Math.min(2, (now - sideState.lastTs) / 1000) : 0.35;
  sideState.lastTs = now;

  const disp = { ...sideState.display };
  for (const a of AXES) {
    const next = raw.axes[a.key];
    if (!Number.isFinite(next)) {
      // Do not coerce missing → 0; freeze last display if any, else null.
      continue;
    }
    disp[a.key] = emaStep(disp[a.key], next, dtSec, PROFILE_EMA_TAU_SEC);
  }
  sideState.display = disp;

  const prev = snapshotAt(sideState.hist, lookbackSec, now);
  sideState.prev = prev
    ? {
        t: prev.t,
        replenishment: prev.replenishment,
        survival: prev.survival,
        cancellation: prev.cancellation,
        consumption: prev.consumption,
        defensePower: prev.defensePower,
        absorptionScore: prev.absorptionScore,
        state: prev.state,
        confidence: prev.confidence,
      }
    : null;

  const compareAxes = {
    replenishment: Number.isFinite(disp.replenishment) ? disp.replenishment : raw.axes.replenishment,
    survival: Number.isFinite(disp.survival) ? disp.survival : raw.axes.survival,
    cancellation: Number.isFinite(disp.cancellation) ? disp.cancellation : raw.axes.cancellation,
    consumption: Number.isFinite(disp.consumption) ? disp.consumption : raw.axes.consumption,
  };
  sideState.deltas = axisDeltas(compareAxes, sideState.prev);

  sideState.profileState = classifyProfileState(
    raw.axes,
    sideState.deltas,
    raw.quality,
    raw.absorption,
    raw.battleState
  );

  // History uses unsmoothed normalized values for later transition analysis.
  const last = sideState.hist[sideState.hist.length - 1];
  const minGap = 200;
  if (!last || now - last.t >= minGap) {
    sideState.hist.push({
      t: now,
      replenishment: raw.axes.replenishment,
      survival: raw.axes.survival,
      cancellation: raw.axes.cancellation,
      consumption: raw.axes.consumption,
      defensePower: raw.defense,
      absorptionScore: raw.absorption,
      state: sideState.profileState,
      confidence: raw.confidence,
      attack: raw.attack,
      battleState: raw.battleState,
      passiveState: raw.passiveState,
    });
  } else {
    Object.assign(last, {
      t: now,
      replenishment: raw.axes.replenishment,
      survival: raw.axes.survival,
      cancellation: raw.axes.cancellation,
      consumption: raw.axes.consumption,
      defensePower: raw.defense,
      absorptionScore: raw.absorption,
      state: sideState.profileState,
      confidence: raw.confidence,
      attack: raw.attack,
      battleState: raw.battleState,
      passiveState: raw.passiveState,
    });
  }
  while (sideState.hist.length && now - sideState.hist[0].t > PROFILE_HIST_KEEP_MS) {
    sideState.hist.shift();
  }
}

export function ingestLiquidityProfile(viz, snapshot, modelWindowSec) {
  if (!viz || !snapshot) return;
  const w = modelWindowSec;
  const pack = snapshot.battlesByWindow?.[w] || snapshot.battlesByWindow?.[String(w)] || null;
  const now = Date.now();
  const lookback = viz.prevLookback || 10;

  ingestSide(viz.ask, w, "ask", readCardProfile(pack?.buy, "ask"), now, lookback);
  ingestSide(viz.bid, w, "bid", readCardProfile(pack?.sell, "bid"), now, lookback);
}

function $(id) {
  return document.getElementById(id);
}

function syncPrevButtons(viz) {
  $("lp-prev-iv")?.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.n) === viz.prevLookback);
  });
}

function stateTone(state) {
  const s = String(state || "");
  if (s === "NO_DATA" || s === "STALE" || s === "LOW_CONFIDENCE") return "warn";
  if (
    s.includes("STRONG") ||
    s.includes("ABSORPTION") ||
    s.includes("STRENGTHENING") ||
    s.includes("ABSORBING") ||
    s.includes("SURVIVAL_STRONG") ||
    s.includes("REPLENISHMENT")
  )
    return "good";
  if (
    s.includes("WEAK") ||
    s.includes("WITHDRAW") ||
    s.includes("COLLAPS") ||
    s.includes("CANCELLATION") ||
    s.includes("WEAKENING")
  )
    return "bad";
  return "neutral";
}

function deltaClass(d) {
  if (!Number.isFinite(d)) return "";
  if (d > 0) return "rise";
  if (d < 0) return "fall";
  return "";
}

function panelHtml(side, st, modelLabel, viz) {
  const isAsk = side === "ask";
  const title = isAsk ? "Passive sellers / asks" : "Passive buyers / bids";
  const attackLabel = isAsk ? "Aggressive Buy Attack" : "Aggressive Sell Attack";
  const absLabel = isAsk ? "Seller Absorption" : "Buyer Absorption";
  const defLabel = isAsk ? "PassiveSellerDefense" : "PassiveBuyerDefense";
  const tone = stateTone(st.profileState);
  const q = st.quality;
  const banner =
    q === "OK"
      ? ""
      : `<div class="lp-banner ${q === "LOW_CONFIDENCE" ? "warn" : "bad"}">${pretty(q)}${
          st.incomplete ? " · PROFILE INCOMPLETE" : ""
        }</div>`;

  const axisRows = AXES.map((a) => {
    const v = st.display[a.key] ?? st.raw[a.key];
    const d = st.deltas?.[a.key];
    return `
      <div class="lp-axis-row" data-axis="${a.key}">
        <span>${a.label}</span>
        <b>${scoreLabel(v)}</b>
        <em class="${deltaClass(d)}">${signed(d)}</em>
      </div>`;
  }).join("");

  const attackBlock = viz.showAttack
    ? `<div class="lp-attack">
         <span>Attack against this side</span>
         <b>${attackLabel} <i>${scoreLabel(st.attack)}</i></b>
       </div>`
    : "";

  const canLabel =
    q !== "OK" || st.incomplete
      ? pretty(q === "OK" ? "LOW_CONFIDENCE" : q)
      : pretty(st.profileState);

  return `
    <div class="lp-panel ${isAsk ? "ask" : "bid"}" data-side="${side}">
      <div class="lp-head">
        <div class="lp-title">${title}</div>
        <div class="lp-model">${modelLabel}</div>
      </div>
      ${banner}
      ${attackBlock}
      <div class="lp-plot">
        <canvas id="lp-canvas-${side}" width="280" height="280"></canvas>
        <div id="lp-tip-${side}" class="lp-tip" hidden></div>
      </div>
      <div class="lp-axes">${axisRows}</div>
      <div class="lp-scores">
        <div class="lp-score">
          <span>Defense</span>
          <b>${scoreLabel(st.defense)} <i>/ 100</i></b>
          <em>${defLabel}</em>
        </div>
        <div class="lp-score">
          <span>Absorption</span>
          <b>${scoreLabel(st.absorption)} <i>/ 100</i></b>
          <em>${absLabel}</em>
        </div>
      </div>
      <div class="lp-state ${tone}">${canLabel}</div>
      <div class="lp-conf">Confidence ${scoreLabel(st.confidence)}%</div>
    </div>
  `;
}

export function ensureLiquidityProfileShell(root, viz, modelLabel, onChange) {
  if (!root) return;
  if (root.dataset.ready === "1") {
    root.querySelectorAll(".lp-model").forEach((el) => {
      el.textContent = modelLabel;
    });
    syncPrevButtons(viz);
    const prevToggle = $("lp-show-prev");
    if (prevToggle) prevToggle.checked = !!viz.showPrevious;
    const atkToggle = $("lp-show-attack");
    if (atkToggle) atkToggle.checked = !!viz.showAttack;
    return;
  }

  root.innerHTML = `
    <div class="lp-wrap">
      <div class="lp-toolbar">
        <div class="lp-toolbar-title">Passive liquidity profile</div>
        <div class="lp-toolbar-sub">Defense shape · same TF as Market Battle</div>
        <div class="lp-windows" id="lp-prev-iv" title="Previous shape lookback">
          ${PROFILE_PREV_WINDOWS.map(
            (it) => `<button type="button" data-n="${it.sec}">${it.label} ago</button>`
          ).join("")}
        </div>
        <label class="lp-toggle">
          <input type="checkbox" id="lp-show-prev" ${viz.showPrevious ? "checked" : ""} />
          Previous shape
        </label>
        <label class="lp-toggle">
          <input type="checkbox" id="lp-show-attack" ${viz.showAttack ? "checked" : ""} />
          Attack overlay
        </label>
      </div>
      <div class="lp-grid">
        <div id="lp-ask-host"></div>
        <div id="lp-bid-host"></div>
      </div>
    </div>
  `;
  root.dataset.ready = "1";

  $("lp-ask-host").innerHTML = panelHtml("ask", viz.ask, modelLabel, viz);
  $("lp-bid-host").innerHTML = panelHtml("bid", viz.bid, modelLabel, viz);

  $("lp-prev-iv")?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.n);
      if (!n || n === viz.prevLookback) return;
      viz.prevLookback = n;
      syncPrevButtons(viz);
      onChange?.();
    });
  });
  $("lp-show-prev")?.addEventListener("change", (e) => {
    viz.showPrevious = !!e.target.checked;
    onChange?.();
  });
  $("lp-show-attack")?.addEventListener("change", (e) => {
    viz.showAttack = !!e.target.checked;
    onChange?.();
  });

  for (const side of ["ask", "bid"]) {
    const canvas = $(`lp-canvas-${side}`);
    canvas?.addEventListener("mousemove", (ev) => onRadarMove(viz, side, ev, onChange));
    canvas?.addEventListener("mouseleave", () => {
      viz.hover = { side: null, axis: null };
      const tip = $(`lp-tip-${side}`);
      if (tip) tip.hidden = true;
      onChange?.();
    });
  }
  syncPrevButtons(viz);
}

function radarLayout(size) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;
  return { cx, cy, r, size };
}

function polar(cx, cy, r, angle, t01) {
  const v = clamp(t01, 0, 1);
  return {
    x: cx + Math.cos(angle) * r * v,
    y: cy + Math.sin(angle) * r * v,
  };
}

function axisPoint(layout, axisKey, score) {
  const axis = AXES.find((a) => a.key === axisKey);
  if (!axis || !Number.isFinite(score)) return null;
  return polar(layout.cx, layout.cy, layout.r, axis.angle, score / 100);
}

function polygonPath(ctx, points) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

function drawRadar(canvas, st, viz, isAsk) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const css = Math.min(canvas.clientWidth || 280, 320);
  const size = Math.max(200, css);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const layout = radarLayout(size);
  const { cx, cy, r } = layout;

  const stroke = isAsk ? "rgba(196, 92, 92, 0.9)" : "rgba(61, 154, 106, 0.9)";
  const fill = isAsk ? "rgba(196, 92, 92, 0.22)" : "rgba(61, 154, 106, 0.22)";
  const prevStroke = isAsk ? "rgba(196, 92, 92, 0.28)" : "rgba(61, 154, 106, 0.28)";
  const prevFill = isAsk ? "rgba(196, 92, 92, 0.06)" : "rgba(61, 154, 106, 0.06)";
  const grid = "rgba(122, 130, 148, 0.28)";
  const labelCol = "rgba(180, 186, 198, 0.95)";

  // Rings
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    for (let i = 0; i < AXES.length; i++) {
      const p = polar(cx, cy, r, AXES[i].angle, ring);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Spokes + labels
  for (const a of AXES) {
    const tip = polar(cx, cy, r, a.angle, 1);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = grid;
    ctx.stroke();

    const lab = polar(cx, cy, r * 1.28, a.angle, 1);
    const score = st.display[a.key] ?? st.raw[a.key];
    ctx.fillStyle = labelCol;
    ctx.font = "600 9px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.short, lab.x, lab.y - 7);
    ctx.fillStyle = Number.isFinite(score) ? (isAsk ? "#c45c5c" : "#3d9a6a") : "rgba(82,90,107,0.9)";
    ctx.font = "700 11px IBM Plex Mono, monospace";
    ctx.fillText(scoreLabel(score), lab.x, lab.y + 7);

    // Hover hit highlight
    if (viz.hover.side === (isAsk ? "ask" : "bid") && viz.hover.axis === a.key) {
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = stroke;
      ctx.fill();
    }
  }

  const incomplete = st.incomplete || st.quality !== "OK";

  // Previous shape (faint)
  if (viz.showPrevious && st.prev) {
    const prevPts = AXES.map((a) => axisPoint(layout, a.key, st.prev[a.key])).filter(Boolean);
    if (prevPts.length === 4) {
      polygonPath(ctx, prevPts);
      ctx.fillStyle = prevFill;
      ctx.fill();
      ctx.strokeStyle = prevStroke;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Current shape — only when we have all 4 axes; otherwise mark incomplete
  const curPts = AXES.map((a) => {
    const v = st.display[a.key] ?? st.raw[a.key];
    return axisPoint(layout, a.key, v);
  });
  const readyPts = curPts.filter(Boolean);
  if (readyPts.length === 4 && !incomplete) {
    polygonPath(ctx, readyPts);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const p of readyPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = stroke;
      ctx.fill();
    }
  } else if (readyPts.length >= 2) {
    // Incomplete: draw available spokes only, no filled polygon / no fake zeros.
    ctx.strokeStyle = "rgba(201, 162, 39, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    for (let i = 0; i < AXES.length; i++) {
      const p = curPts[i];
      if (!p) continue;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(201, 162, 39, 0.9)";
      ctx.fill();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(201, 162, 39, 0.85)";
    ctx.font = "700 10px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(pretty(st.quality === "OK" ? "INCOMPLETE" : st.quality), cx, cy);
  } else {
    ctx.fillStyle = "rgba(122, 130, 148, 0.85)";
    ctx.font = "700 11px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(pretty(st.quality || "NO DATA"), cx, cy);
  }

  // Optional attack marker (external, not an axis)
  if (viz.showAttack && Number.isFinite(st.attack)) {
    const y = 16;
    ctx.fillStyle = isAsk ? "rgba(61, 154, 106, 0.95)" : "rgba(196, 92, 92, 0.95)";
    ctx.font = "600 9px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`ATK ${Math.round(st.attack)}`, cx, y);
    ctx.beginPath();
    ctx.moveTo(cx, y + 8);
    ctx.lineTo(cx - 5, y + 14);
    ctx.lineTo(cx + 5, y + 14);
    ctx.closePath();
    ctx.fill();
  }
}

function nearestAxis(layout, mx, my) {
  let best = null;
  let bestDist = 28;
  for (const a of AXES) {
    const tip = polar(layout.cx, layout.cy, layout.r * 1.15, a.angle, 1);
    const d = Math.hypot(mx - tip.x, my - tip.y);
    if (d < bestDist) {
      bestDist = d;
      best = a.key;
    }
  }
  return best;
}

function onRadarMove(viz, side, ev, redraw) {
  const canvas = $(`lp-canvas-${side}`);
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const layout = radarLayout(rect.width);
  const axis = nearestAxis(layout, mx, my);
  viz.hover = { side, axis };
  redraw?.();

  const tip = $(`lp-tip-${side}`);
  const st = side === "ask" ? viz.ask : viz.bid;
  if (!tip || !axis) {
    if (tip) tip.hidden = true;
    return;
  }

  const axisMeta = AXES.find((a) => a.key === axis);
  const score = st.display[axis] ?? st.raw[axis];
  const rawDollar = st.dollars?.[axis];
  const pct = st.percentiles?.[axis];
  const delta = st.deltas?.[axis];
  const prevLabel = PROFILE_PREV_WINDOWS.find((w) => w.sec === viz.prevLookback)?.label || `${viz.prevLookback}s`;
  const trend = trendFromDelta(delta);
  const isAsk = side === "ask";
  const prefix = isAsk ? "ASK" : "BID";
  const rawLine =
    axis === "survival"
      ? `Survival score ${scoreLabel(rawDollar)} / 100`
      : fmtUsd(rawDollar);

  tip.hidden = false;
  tip.innerHTML = `
    <div class="lp-tip-title">${prefix} ${axisMeta.label}</div>
    <div class="lp-tip-row"><span>Score</span><b>${scoreLabel(score)} / 100</b></div>
    <div class="lp-tip-row"><span>Raw</span><b>${rawLine}</b></div>
    <div class="lp-tip-row"><span>Percentile</span><b>${pctOrdinal(pct)}</b></div>
    <div class="lp-tip-row"><span>Trend</span><b>${pretty(trend)}</b></div>
    <div class="lp-tip-row"><span>${prevLabel} Change</span><b class="${deltaClass(delta)}">${signed(delta)}</b></div>
  `;
  const tw = tip.offsetWidth || 180;
  const th = tip.offsetHeight || 120;
  let left = mx + 12;
  let top = my - th - 8;
  if (left + tw > rect.width - 4) left = mx - tw - 12;
  if (top < 4) top = my + 12;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

function refreshPanelDom(side, viz, modelLabel) {
  const host = $(`lp-${side}-host`);
  if (!host) return;
  const st = side === "ask" ? viz.ask : viz.bid;
  // Preserve hover tip node by rewriting host; canvas redrawn after.
  host.innerHTML = panelHtml(side, st, modelLabel, viz);
  const canvas = $(`lp-canvas-${side}`);
  canvas?.addEventListener("mousemove", (ev) =>
    onRadarMove(viz, side, ev, () => paintLiquidityProfile(viz, modelLabel))
  );
  canvas?.addEventListener("mouseleave", () => {
    viz.hover = { side: null, axis: null };
    const tip = $(`lp-tip-${side}`);
    if (tip) tip.hidden = true;
    paintLiquidityProfile(viz, modelLabel);
  });
}

export function paintLiquidityProfile(viz, modelLabel) {
  if (!viz) return;
  const root = $("liquidity-profile-root");
  if (!root || root.dataset.ready !== "1") return;

  // Update live text without full rebuild when possible
  for (const side of ["ask", "bid"]) {
    const host = $(`lp-${side}-host`);
    if (!host?.querySelector(".lp-panel")) {
      refreshPanelDom(side, viz, modelLabel);
    } else {
      // Lightweight text refresh
      const st = side === "ask" ? viz.ask : viz.bid;
      const panel = host.querySelector(".lp-panel");
      if (panel) {
        panel.querySelector(".lp-model") && (panel.querySelector(".lp-model").textContent = modelLabel);
        const banner = panel.querySelector(".lp-banner");
        const q = st.quality;
        if (q !== "OK") {
          const html = `${pretty(q)}${st.incomplete ? " · PROFILE INCOMPLETE" : ""}`;
          if (!banner) {
            const head = panel.querySelector(".lp-head");
            head?.insertAdjacentHTML(
              "afterend",
              `<div class="lp-banner ${q === "LOW_CONFIDENCE" ? "warn" : "bad"}">${html}</div>`
            );
          } else {
            banner.textContent = html;
            banner.className = `lp-banner ${q === "LOW_CONFIDENCE" ? "warn" : "bad"}`;
          }
        } else if (banner) banner.remove();

        const atk = panel.querySelector(".lp-attack i");
        const atkBlock = panel.querySelector(".lp-attack");
        if (viz.showAttack && !atkBlock) {
          refreshPanelDom(side, viz, modelLabel);
          continue;
        }
        if (!viz.showAttack && atkBlock) {
          refreshPanelDom(side, viz, modelLabel);
          continue;
        }
        if (atk) atk.textContent = scoreLabel(st.attack);

        panel.querySelectorAll(".lp-axis-row").forEach((row) => {
          const key = row.dataset.axis;
          const v = st.display[key] ?? st.raw[key];
          const d = st.deltas?.[key];
          const b = row.querySelector("b");
          const em = row.querySelector("em");
          if (b) b.textContent = scoreLabel(v);
          if (em) {
            em.textContent = signed(d);
            em.className = deltaClass(d);
          }
        });

        const scores = panel.querySelectorAll(".lp-score b");
        if (scores[0]) scores[0].innerHTML = `${scoreLabel(st.defense)} <i>/ 100</i>`;
        if (scores[1]) scores[1].innerHTML = `${scoreLabel(st.absorption)} <i>/ 100</i>`;

        const stateEl = panel.querySelector(".lp-state");
        if (stateEl) {
          const label =
            q !== "OK" || st.incomplete
              ? pretty(q === "OK" ? "LOW_CONFIDENCE" : q)
              : pretty(st.profileState);
          stateEl.textContent = label;
          stateEl.className = `lp-state ${stateTone(st.profileState)}`;
        }
        const conf = panel.querySelector(".lp-conf");
        if (conf) conf.textContent = `Confidence ${scoreLabel(st.confidence)}%`;
      }
    }
    drawRadar($(`lp-canvas-${side}`), side === "ask" ? viz.ask : viz.bid, viz, side === "ask");
  }
}

/** Snapshot history for later transition analysis / console. */
export function liquidityProfileHistory(viz) {
  if (!viz) return { ask: [], bid: [] };
  return {
    ask: [...(viz.ask.hist || [])],
    bid: [...(viz.bid.hist || [])],
  };
}
