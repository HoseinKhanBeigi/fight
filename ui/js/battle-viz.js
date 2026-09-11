/**
 * Market Battle visualization (display-only).
 * Does NOT modify AggressiveBuyPower / Passive*Defense / battle scoring.
 */

export const BATTLE_CHART_MS = 750;
export const BATTLE_EMA_TAU_SEC = 3;
export const BATTLE_HIST_KEEP_MS = 900_000;
export const BATTLE_CROSS_GAP = 8;
export const BATTLE_CROSS_HOLD_MS = 2500;
export const BATTLE_CHART_WINDOWS = [
  { sec: 30, label: "30s" },
  { sec: 60, label: "1m" },
  { sec: 300, label: "5m" },
  { sec: 900, label: "15m" },
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

function displayState(side, state = "") {
  const s = String(state || "BALANCED");
  if (side === "up") {
    if (s === "CONTROL_SHIFTING_TO_ATTACK") return "CONTROL_SHIFTING_TO_BUYERS";
    if (s === "CONTROL_SHIFTING_TO_DEFENSE") return "CONTROL_SHIFTING_TO_SELLERS";
    if (s === "ATTACK_CROSSED_DEFENSE") return "BUY_ATTACK_CROSSED_SELLER_DEFENSE";
    if (s === "DEFENSE_CROSSED_ATTACK") return "SELLER_DEFENSE_CROSSED_BUY_ATTACK";
  } else {
    if (s === "CONTROL_SHIFTING_TO_ATTACK") return "CONTROL_SHIFTING_TO_SELLERS";
    if (s === "CONTROL_SHIFTING_TO_DEFENSE") return "CONTROL_SHIFTING_TO_BUYERS";
    if (s === "ATTACK_CROSSED_DEFENSE") return "SELL_ATTACK_CROSSED_BUYER_DEFENSE";
    if (s === "DEFENSE_CROSSED_ATTACK") return "BUYER_DEFENSE_CROSSED_SELL_ATTACK";
  }
  return s;
}

function fmtClock(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function signed(n) {
  if (!Number.isFinite(n)) return "—";
  const v = Math.round(n);
  return v > 0 ? `+${v}` : String(v);
}

function scoreLabel(n) {
  return Number.isFinite(n) ? String(Math.round(n)) : "—";
}

function trendFromHist(hist, field, lookbackSec = BATTLE_EMA_TAU_SEC) {
  if (!hist?.length) return "STABLE";
  const now = hist[hist.length - 1];
  if (!Number.isFinite(now[field])) return "STABLE";
  const target = now.t - lookbackSec * 1000;
  let then = hist[0][field];
  for (const row of hist) {
    if (row.t >= target) {
      then = row[field];
      break;
    }
    then = row[field];
  }
  if (!Number.isFinite(then)) return "STABLE";
  const delta = now[field] - then;
  if (delta >= 12) return "RISING_FAST";
  if (delta >= 4) return "RISING";
  if (delta <= -12) return "FALLING_FAST";
  if (delta <= -4) return "FALLING";
  return "STABLE";
}

function spreadTrendLabel(hist) {
  const t = trendFromHist(hist, "spread");
  if (t === "RISING_FAST" || t === "RISING") {
    const last = hist[hist.length - 1]?.spread ?? 0;
    return last >= 0 ? "EXPANDING_POSITIVE" : "CONTRACTING_NEGATIVE";
  }
  if (t === "FALLING_FAST" || t === "FALLING") {
    const last = hist[hist.length - 1]?.spread ?? 0;
    return last >= 0 ? "CONTRACTING_POSITIVE" : "EXPANDING_NEGATIVE";
  }
  return "STABLE";
}

function controlState({ attack, defense, spread, atkTrend, defTrend, pendingCross, lastCross }) {
  if (!Number.isFinite(attack) || !Number.isFinite(defense)) return "BALANCED";
  const gap = Math.abs(spread);
  if (pendingCross === "attack") return "APPROACHING_CROSSOVER";
  if (pendingCross === "defense") return "APPROACHING_CROSSOVER";
  if (lastCross?.side === "attack" && Date.now() - lastCross.t < 4000) return "ATTACK_CROSSED_DEFENSE";
  if (lastCross?.side === "defense" && Date.now() - lastCross.t < 4000) return "DEFENSE_CROSSED_ATTACK";

  const atkRising = atkTrend === "RISING" || atkTrend === "RISING_FAST";
  const atkFalling = atkTrend === "FALLING" || atkTrend === "FALLING_FAST";
  const defRising = defTrend === "RISING" || defTrend === "RISING_FAST";
  const defFalling = defTrend === "FALLING" || defTrend === "FALLING_FAST";

  if (atkRising && defFalling && spread < 8 && spread > -8) return "CONTROL_SHIFTING_TO_ATTACK";
  if (defRising && atkFalling && spread < 8 && spread > -8) return "CONTROL_SHIFTING_TO_DEFENSE";
  if (atkRising && !defRising) return "ATTACK_BUILDING";
  if (defRising && !atkRising) return "DEFENSE_BUILDING";
  if (atkFalling) return "ATTACK_WEAKENING";
  if (defFalling) return "DEFENSE_WEAKENING";
  if (spread >= 12) return "ATTACK_DOMINANT";
  if (spread <= -12) return "DEFENSE_DOMINANT";
  if (gap < 8) return "BALANCED";
  return spread > 0 ? "ATTACK_DOMINANT" : "DEFENSE_DOMINANT";
}

function emptySide(modelWindow) {
  return {
    modelWindow,
    attack: null,
    defense: null,
    spread: null,
    rawAttack: null,
    rawDefense: null,
    lastTs: 0,
    hist: [],
    crosses: [],
    crossPending: null,
    events: [],
    scaleValid: true,
    quality: "OK",
  };
}

export function createBattleVizState() {
  return {
    chartWindow: 60,
    paintAt: 0,
    priceOverlay: false,
    hover: { side: null, t: null },
    layouts: { up: null, down: null },
    upside: emptySide(60),
    downside: emptySide(60),
    pathMarkers: [],
  };
}

function readPowers(pack, side) {
  const card = side === "up" ? pack?.buy : pack?.sell;
  if (!card) return { attack: null, defense: null, quality: "NO_DATA", scaleValid: false };

  const attack =
    side === "up"
      ? card.attack?.AggressiveBuyPower ?? card.attack?.power ?? pack?.AggressiveBuyPower
      : card.attack?.AggressiveSellPower ?? card.attack?.power ?? pack?.AggressiveSellPower;
  const defense =
    side === "up"
      ? card.defense?.PassiveSellerDefense ?? card.defense?.power ?? pack?.PassiveSellerDefense
      : card.defense?.PassiveBuyerDefense ?? card.defense?.power ?? pack?.PassiveBuyerDefense;

  const atkQ = card.attack?.dataQuality || "OK";
  const defQ = card.defense?.dataQuality || "OK";
  let quality = "OK";
  if (atkQ === "NO_DATA" || attack == null) quality = "NO_TRADE_DATA";
  else if (defQ === "NO_DATA" || defense == null) quality = "NO_BOOK_DATA";
  else if (atkQ === "STALE" || defQ === "STALE" || card.state === "STALE") quality = "STALE";
  else if (atkQ === "LOW_CONFIDENCE" || defQ === "LOW_CONFIDENCE" || card.state === "LOW_CONFIDENCE")
    quality = "LOW_CONFIDENCE";
  else if (card.state === "NO_DATA") quality = "NO_DATA";

  const scaleValid =
    (attack == null || (attack >= 0 && attack <= 100)) &&
    (defense == null || (defense >= 0 && defense <= 100));

  return {
    attack: Number.isFinite(attack) ? clamp(attack, 0, 100) : null,
    defense: Number.isFinite(defense) ? clamp(defense, 0, 100) : null,
    quality,
    scaleValid,
  };
}

function ingestCross(sideState, now) {
  const hist = sideState.hist;
  if (hist.length < 2) return;
  const prev = hist[hist.length - 2];
  const cur = hist[hist.length - 1];
  if (!Number.isFinite(prev.attack) || !Number.isFinite(prev.defense)) return;
  if (!Number.isFinite(cur.attack) || !Number.isFinite(cur.defense)) return;

  const prevDiff = prev.attack - prev.defense;
  const diff = cur.attack - cur.defense;
  const crossedAttack = prevDiff <= 0 && diff > 0;
  const crossedDefense = prevDiff >= 0 && diff < 0;

  if (crossedAttack) sideState.crossPending = { side: "attack", t: now, leadSince: null };
  else if (crossedDefense) sideState.crossPending = { side: "defense", t: now, leadSince: null };

  const pending = sideState.crossPending;
  if (!pending) return;

  const stillAhead = pending.side === "attack" ? diff > 0 : diff < 0;
  const gapOk = Math.abs(diff) >= BATTLE_CROSS_GAP;
  if (!stillAhead) {
    sideState.crossPending = null;
    return;
  }
  if (!gapOk) {
    pending.leadSince = null;
    return;
  }
  if (!pending.leadSince) pending.leadSince = now;
  if (now - pending.leadSince < BATTLE_CROSS_HOLD_MS) return;

  const last = sideState.crosses[sideState.crosses.length - 1];
  if (!last || last.side !== pending.side || now - last.t > 4000) {
    const event = {
      t: pending.t,
      side: pending.side,
      attack: cur.attack,
      defense: cur.defense,
      spread: cur.spread,
      state: cur.state,
    };
    sideState.crosses.push(event);
    sideState.events.push({
      type: pending.side === "attack" ? "ATTACK_CROSS" : "DEFENSE_CROSS",
      ...event,
    });
    const lastSp = hist.length >= 4 ? hist[hist.length - 4].spread : prev.spread;
    if (Number.isFinite(lastSp) && Math.abs(cur.spread) - Math.abs(lastSp) >= 6) {
      sideState.events.push({
        type: "SPREAD_EXPANDING",
        t: now,
        attack: cur.attack,
        defense: cur.defense,
        spread: cur.spread,
        state: cur.state,
      });
    }
  }
  sideState.crossPending = null;
  while (sideState.crosses.length && now - sideState.crosses[0].t > BATTLE_HIST_KEEP_MS) {
    sideState.crosses.shift();
  }
  while (sideState.events.length > 200) sideState.events.shift();
}

function ingestSide(sideState, modelWindow, raw, price, now) {
  if (sideState.modelWindow !== modelWindow) {
    Object.assign(sideState, emptySide(modelWindow));
  }
  const dtSec = sideState.lastTs ? Math.min(2, (now - sideState.lastTs) / 1000) : 0.25;
  sideState.lastTs = now;
  sideState.quality = raw.quality;
  sideState.scaleValid = raw.scaleValid;
  sideState.rawAttack = raw.attack;
  sideState.rawDefense = raw.defense;

  if (Number.isFinite(raw.attack)) {
    sideState.attack = emaStep(sideState.attack, raw.attack, dtSec, BATTLE_EMA_TAU_SEC);
  } else {
    sideState.attack = null;
  }
  if (Number.isFinite(raw.defense)) {
    sideState.defense = emaStep(sideState.defense, raw.defense, dtSec, BATTLE_EMA_TAU_SEC);
  } else {
    sideState.defense = null;
  }

  const spread =
    Number.isFinite(sideState.attack) && Number.isFinite(sideState.defense)
      ? sideState.attack - sideState.defense
      : null;
  sideState.spread = spread;

  const row = {
    t: now,
    attack: sideState.attack,
    defense: sideState.defense,
    spread,
    price: Number.isFinite(price) ? price : null,
    quality: raw.quality,
  };
  // provisional trends/state filled after push
  sideState.hist.push(row);
  const cutoff = now - BATTLE_HIST_KEEP_MS;
  while (sideState.hist.length > 2 && sideState.hist[0].t < cutoff) sideState.hist.shift();

  row.attackTrend = trendFromHist(sideState.hist, "attack");
  row.defenseTrend = trendFromHist(sideState.hist, "defense");
  row.spreadTrend = spreadTrendLabel(sideState.hist);
  row.state = controlState({
    attack: sideState.attack,
    defense: sideState.defense,
    spread: spread ?? 0,
    atkTrend: row.attackTrend,
    defTrend: row.defenseTrend,
    pendingCross: sideState.crossPending?.side || null,
    lastCross: sideState.crosses[sideState.crosses.length - 1] || null,
  });

  ingestCross(sideState, now);
  return sideState;
}

/** Ingest display-only sample from existing battle snapshot (no scoring changes). */
export function ingestBattleViz(viz, s, modelWindow) {
  const pack = s?.battlesByWindow?.[modelWindow] || s?.battlesByWindow?.[String(modelWindow)];
  const now = Date.now();
  const price = s?.price ?? s?.bestBid ?? s?.bestAsk;
  const up = readPowers(pack, "up");
  const down = readPowers(pack, "down");
  ingestSide(viz.upside, modelWindow, up, price, now);
  ingestSide(viz.downside, modelWindow, down, price, now);
  viz.pathMarkers = Array.isArray(s?.pathTest?.chartMarkers) ? s.pathTest.chartMarkers : [];
  return viz;
}

function samples(sideState, spanSec, now) {
  const t1 = now;
  const t0 = t1 - spanSec * 1000;
  const rows = (sideState?.hist || []).filter((p) => p.t >= t0);
  return { t0, t1, rows };
}

function nearest(rows, t) {
  if (!rows.length) return null;
  let best = rows[0];
  let bestD = Math.abs(rows[0].t - t);
  for (const row of rows) {
    const d = Math.abs(row.t - t);
    if (d < bestD) {
      best = row;
      bestD = d;
    }
  }
  return best;
}

function latest(sideState) {
  const h = sideState.hist;
  return h.length ? h[h.length - 1] : null;
}

function trendClass(t = "") {
  const s = String(t).toUpperCase();
  if (s.includes("RISING") || s.includes("EXPANDING_POSITIVE") || s.includes("CONTRACTING_NEGATIVE"))
    return "rise";
  if (s.includes("FALLING") || s.includes("EXPANDING_NEGATIVE") || s.includes("CONTRACTING_POSITIVE"))
    return "fall";
  return "";
}

function stateClass(state = "") {
  const s = String(state).toUpperCase();
  if (s.includes("ATTACK") && !s.includes("DEFENSE")) return "atk";
  if (s.includes("DEFENSE") && !s.includes("ATTACK")) return "def";
  if (s.includes("CROSS") || s.includes("SHIFT")) return "shift";
  if (s.includes("BALANCED")) return "bal";
  return "bal";
}

function panelHtml(side, sideState, modelLabel) {
  const row = latest(sideState);
  const isUp = side === "up";
  const atkName = isUp ? "Buy Attack" : "Sell Attack";
  const defName = isUp ? "Seller Defense" : "Buyer Defense";
  const title = isUp ? "Upside battle" : "Downside battle";
  const q = sideState.quality;
  let banner = "";
  if (!sideState.scaleValid) banner = `<div class="bv-banner bad">COMPARISON SCALE INVALID</div>`;
  else if (q === "NO_TRADE_DATA" || q === "NO_DATA") banner = `<div class="bv-banner">NO TRADE DATA</div>`;
  else if (q === "NO_BOOK_DATA") banner = `<div class="bv-banner">NO BOOK DATA</div>`;
  else if (q === "STALE" || q === "LOW_CONFIDENCE")
    banner = `<div class="bv-banner warn">LOW CONFIDENCE</div>`;

  const atk = row?.attack;
  const def = row?.defense;
  const spr = row?.spread;
  const atkT = row?.attackTrend || "STABLE";
  const defT = row?.defenseTrend || "STABLE";
  const sprT = row?.spreadTrend || "STABLE";
  const st = row?.state || "BALANCED";
  const stShown = displayState(side, st);

  return `
    <div class="bv-panel ${isUp ? "up" : "down"}" data-side="${side}">
      <div class="bv-head">
        <div class="bv-title">${title}</div>
        <div class="bv-model">${modelLabel}</div>
      </div>
      ${banner}
      <div class="bv-summary">
        <div class="bv-metric atk">
          <div class="bv-kicker">${atkName}</div>
          <div class="bv-score">${scoreLabel(atk)}</div>
          <div class="bv-trend ${trendClass(atkT)}">${pretty(atkT)}</div>
        </div>
        <div class="bv-metric def">
          <div class="bv-kicker">${defName}</div>
          <div class="bv-score">${scoreLabel(def)}</div>
          <div class="bv-trend ${trendClass(defT)}">${pretty(defT)}</div>
        </div>
        <div class="bv-metric spr">
          <div class="bv-kicker">Spread</div>
          <div class="bv-score ${Number(spr) > 4 ? "pos" : Number(spr) < -4 ? "neg" : ""}">${signed(spr)}</div>
          <div class="bv-trend ${trendClass(sprT)}">${pretty(sprT)}</div>
        </div>
      </div>
      <div class="bv-state ${stateClass(st)}">${pretty(stShown)}</div>
      <div class="bv-legend">
        <span class="atk">${isUp ? "BUY ATTACK" : "SELL ATTACK"}</span>
        <span class="def">${isUp ? "SELLER DEFENSE" : "BUYER DEFENSE"}</span>
      </div>
      <div class="bv-plot">
        <canvas id="bv-canvas-${side}"></canvas>
        <div id="bv-tip-${side}" class="bv-tip" hidden></div>
      </div>
      <div class="bv-spread-label">Battle spread</div>
      <div class="bv-spread-plot">
        <canvas id="bv-spread-${side}"></canvas>
      </div>
    </div>
  `;
}

export function ensureBattleVizShell(root, viz, modelLabel, onWindowChange) {
  if (!root) return;
  if (root.dataset.ready === "1") {
    root.querySelectorAll(".bv-model").forEach((el) => {
      el.textContent = modelLabel;
    });
    syncWindowButtons(viz);
    return;
  }
  root.innerHTML = `
    <div class="bv-wrap">
      <div class="bv-toolbar">
        <div class="bv-toolbar-title">Market battle</div>
        <div class="bv-windows" id="bv-hist-iv">
          ${BATTLE_CHART_WINDOWS.map(
            (it) => `<button type="button" data-n="${it.sec}">${it.label}</button>`
          ).join("")}
        </div>
        <label class="bv-price-toggle">
          <input type="checkbox" id="bv-price-overlay" ${viz.priceOverlay ? "checked" : ""} />
          Price overlay
        </label>
      </div>
      <div class="bv-grid">
        <div id="bv-up-host"></div>
        <div id="bv-down-host"></div>
      </div>
    </div>
  `;
  root.dataset.ready = "1";

  $("bv-up-host").innerHTML = panelHtml("up", viz.upside, modelLabel);
  $("bv-down-host").innerHTML = panelHtml("down", viz.downside, modelLabel);

  $("bv-hist-iv")?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.n);
      if (!n || n === viz.chartWindow) return;
      viz.chartWindow = n;
      syncWindowButtons(viz);
      onWindowChange?.();
    });
  });
  $("bv-price-overlay")?.addEventListener("change", (e) => {
    viz.priceOverlay = !!e.target.checked;
    onWindowChange?.();
  });

  for (const side of ["up", "down"]) {
    const canvas = $(`bv-canvas-${side}`);
    canvas?.addEventListener("mousemove", (ev) => onMove(viz, side, ev, onWindowChange));
    canvas?.addEventListener("mouseleave", () => {
      viz.hover = { side: null, t: null };
      const tip = $(`bv-tip-${side}`);
      if (tip) tip.hidden = true;
      onWindowChange?.();
    });
  }
  syncWindowButtons(viz);
}

function $(id) {
  return document.getElementById(id);
}

function syncWindowButtons(viz) {
  $("bv-hist-iv")?.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.n) === viz.chartWindow);
  });
}

function onMove(viz, side, ev, redraw) {
  const layout = viz.layouts[side];
  if (!layout) return;
  const canvas = $(`bv-canvas-${side}`);
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const x = mx - layout.padL;
  if (x < 0 || x > layout.plotW) {
    viz.hover = { side: null, t: null };
    const tip = $(`bv-tip-${side}`);
    if (tip) tip.hidden = true;
    redraw?.();
    return;
  }
  const t = layout.t0 + (x / layout.plotW) * (layout.t1 - layout.t0);
  viz.hover = { side, t };
  redraw?.();

  const row = nearest(layout.rows, t);
  const tip = $(`bv-tip-${side}`);
  if (!tip || !row) return;
  const isUp = side === "up";
  tip.hidden = false;
  tip.innerHTML = `
    <div class="bv-tip-time">${fmtClock(row.t)}</div>
    <div class="bv-tip-row"><span>${isUp ? "Buy Attack" : "Sell Attack"}</span><b class="atk">${scoreLabel(row.attack)}</b></div>
    <div class="bv-tip-row"><span>${isUp ? "Seller Defense" : "Buyer Defense"}</span><b class="def">${scoreLabel(row.defense)}</b></div>
    <div class="bv-tip-row"><span>Spread</span><b class="${Number(row.spread) > 0 ? "pos" : Number(row.spread) < 0 ? "neg" : ""}">${signed(row.spread)}</b></div>
    <div class="bv-tip-row"><span>Attack Trend</span><b>${pretty(row.attackTrend)}</b></div>
    <div class="bv-tip-row"><span>Defense Trend</span><b>${pretty(row.defenseTrend)}</b></div>
    <div class="bv-tip-row"><span>State</span><b>${pretty(displayState(side, row.state))}</b></div>
  `;
  const tw = tip.offsetWidth || 170;
  const th = tip.offsetHeight || 120;
  let left = mx + 12;
  let top = ev.clientY - rect.top - th - 8;
  if (left + tw > rect.width - 4) left = mx - tw - 12;
  if (top < 4) top = ev.clientY - rect.top + 12;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

function paintSummary(side, sideState, modelLabel) {
  const host = $(side === "up" ? "bv-up-host" : "bv-down-host");
  if (!host) return;
  // Update text nodes without destroying canvases
  const panel = host.querySelector(".bv-panel");
  if (!panel) {
    host.innerHTML = panelHtml(side, sideState, modelLabel);
    return;
  }
  const row = latest(sideState);
  panel.querySelector(".bv-model").textContent = modelLabel;
  const scores = panel.querySelectorAll(".bv-score");
  const trends = panel.querySelectorAll(".bv-trend");
  if (scores[0]) scores[0].textContent = scoreLabel(row?.attack);
  if (scores[1]) scores[1].textContent = scoreLabel(row?.defense);
  if (scores[2]) {
    scores[2].textContent = signed(row?.spread);
    scores[2].className = `bv-score ${Number(row?.spread) > 4 ? "pos" : Number(row?.spread) < -4 ? "neg" : ""}`;
  }
  if (trends[0]) {
    trends[0].textContent = pretty(row?.attackTrend || "STABLE");
    trends[0].className = `bv-trend ${trendClass(row?.attackTrend)}`;
  }
  if (trends[1]) {
    trends[1].textContent = pretty(row?.defenseTrend || "STABLE");
    trends[1].className = `bv-trend ${trendClass(row?.defenseTrend)}`;
  }
  if (trends[2]) {
    trends[2].textContent = pretty(row?.spreadTrend || "STABLE");
    trends[2].className = `bv-trend ${trendClass(row?.spreadTrend)}`;
  }
  const st = panel.querySelector(".bv-state");
  if (st) {
    st.textContent = pretty(displayState(side, row?.state || "BALANCED"));
    st.className = `bv-state ${stateClass(row?.state)}`;
  }
  let banner = panel.querySelector(".bv-banner");
  const q = sideState.quality;
  let text = "";
  let cls = "bv-banner";
  if (!sideState.scaleValid) {
    text = "COMPARISON SCALE INVALID";
    cls += " bad";
  } else if (q === "NO_TRADE_DATA" || q === "NO_DATA") text = "NO TRADE DATA";
  else if (q === "NO_BOOK_DATA") text = "NO BOOK DATA";
  else if (q === "STALE" || q === "LOW_CONFIDENCE") {
    text = "LOW CONFIDENCE";
    cls += " warn";
  }
  if (text) {
    if (!banner) {
      banner = document.createElement("div");
      panel.querySelector(".bv-head")?.after(banner);
    }
    banner.className = cls;
    banner.textContent = text;
  } else if (banner) {
    banner.remove();
  }
}

function drawPathMarkers(ctx, viz, { padL, padT, plotW, plotH, t0, t1, xAt, yAt, side }) {
  const marks = (viz.pathMarkers || []).filter((m) => m.t >= t0 && m.t <= t1);
  if (!marks.length) return;
  ctx.save();
  ctx.font = "8px IBM Plex Sans, sans-serif";
  ctx.textBaseline = "top";
  for (const m of marks) {
    const x = xAt(m.t);
    const up = m.direction === "UP";
    const color = up ? "#3d9a6a" : "#c45c5c";
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.strokeStyle = m.pending ? "rgba(201,162,39,0.45)" : up ? "rgba(61,154,106,0.4)" : "rgba(196,92,92,0.4)";
    ctx.setLineDash(m.pending ? [3, 3] : []);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    const y = padT + 12 + (up ? 0 : 14);
    ctx.fillStyle = m.pending ? "#c9a227" : color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 4, y + 7);
    ctx.lineTo(x + 4, y + 7);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = x > padL + plotW - 90 ? "right" : "left";
    const score = Number.isFinite(m.score) ? (m.score > 0 ? `+${Math.round(m.score)}` : String(Math.round(m.score))) : "";
    let label = `${m.direction} ${score}`;
    if (!m.pending && m.outcome) {
      const mark = m.correct ? "✓" : "✕";
      label = `${m.outcome} ${mark}`;
    } else if (m.pending) {
      label = `${label} 15m`;
    }
    if (side === "up") {
      ctx.fillText(label, x + (x > padL + plotW - 90 ? -5 : 5), y + 8);
    }
  }
  ctx.restore();
}

function sizeCanvas(canvas, cssH) {
  const plot = canvas.parentElement;
  const cssW = Math.max(1, Math.floor(plot.clientWidth || plot.getBoundingClientRect().width));
  const h = Math.max(cssH, Math.floor(plot.clientHeight || cssH));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, h);
  return { ctx, cssW, cssH: h };
}

function drawMain(viz, side) {
  const canvas = $(`bv-canvas-${side}`);
  if (!canvas) return;
  const sideState = side === "up" ? viz.upside : viz.downside;
  const now = Date.now();
  const { t0, t1, rows } = samples(sideState, viz.chartWindow || 60, now);
  const { ctx, cssW, cssH } = sizeCanvas(canvas, 110);
  const padL = 28;
  const padR = 8;
  const padT = 10;
  const padB = 6;
  const plotW = Math.max(1, cssW - padL - padR);
  const plotH = Math.max(1, cssH - padT - padB);
  const xAt = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const yAt = (v) => padT + (1 - clamp(v, 0, 100) / 100) * plotH;
  viz.layouts[side] = { padL, padT, plotW, plotH, t0, t1, rows };

  const atkColor = side === "up" ? "#3d9a6a" : "#c45c5c";
  const defColor = side === "up" ? "#c45c5c" : "#3d9a6a";

  ctx.font = "9px IBM Plex Mono, SF Mono, Consolas, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const level of [0, 25, 50, 75, 100]) {
    const y = yAt(level);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.strokeStyle = level === 50 ? "rgba(232,234,239,0.2)" : "rgba(82,90,107,0.3)";
    ctx.setLineDash(level === 50 ? [3, 3] : level === 0 || level === 100 ? [] : [2, 4]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = level === 50 ? "#b4bac6" : "#525a6b";
    ctx.fillText(String(level), padL - 4, y);
  }

  if (!sideState.scaleValid) {
    ctx.fillStyle = "#c45c5c";
    ctx.textAlign = "center";
    ctx.font = "11px IBM Plex Sans, sans-serif";
    ctx.fillText("COMPARISON SCALE INVALID", padL + plotW / 2, padT + plotH / 2);
    return;
  }

  const valid = rows.filter((r) => Number.isFinite(r.attack) && Number.isFinite(r.defense));
  if (valid.length >= 2) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    for (let i = 0; i < valid.length - 1; i++) {
      const a = valid[i];
      const b = valid[i + 1];
      const atkDom = (a.attack + b.attack) / 2 >= (a.defense + b.defense) / 2;
      ctx.beginPath();
      ctx.moveTo(xAt(a.t), yAt(a.attack));
      ctx.lineTo(xAt(b.t), yAt(b.attack));
      ctx.lineTo(xAt(b.t), yAt(b.defense));
      ctx.lineTo(xAt(a.t), yAt(a.defense));
      ctx.closePath();
      ctx.fillStyle = atkDom
        ? side === "up"
          ? "rgba(61,154,106,0.08)"
          : "rgba(196,92,92,0.08)"
        : side === "up"
          ? "rgba(196,92,92,0.08)"
          : "rgba(61,154,106,0.08)";
      ctx.fill();
    }
    const stroke = (field, color) => {
      ctx.beginPath();
      valid.forEach((p, i) => {
        const x = xAt(p.t);
        const y = yAt(p[field]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    };
    stroke("defense", defColor);
    stroke("attack", atkColor);
    ctx.restore();
  }

  // Optional subtle price overlay
  if (viz.priceOverlay) {
    const priced = rows.filter((r) => Number.isFinite(r.price));
    if (priced.length >= 2) {
      let minP = priced[0].price;
      let maxP = priced[0].price;
      for (const p of priced) {
        minP = Math.min(minP, p.price);
        maxP = Math.max(maxP, p.price);
      }
      const span = Math.max(maxP - minP, 1e-9);
      ctx.beginPath();
      priced.forEach((p, i) => {
        const x = xAt(p.t);
        const y = padT + (1 - (p.price - minP) / span) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "rgba(180,186,198,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const crosses = (sideState.crosses || []).filter((c) => c.t >= t0 && c.t <= t1);
  ctx.font = "8px IBM Plex Sans, sans-serif";
  ctx.textBaseline = "bottom";
  for (const mark of crosses) {
    const x = xAt(mark.t);
    const row = nearest(valid, mark.t);
    const y = yAt(((row?.attack ?? 50) + (row?.defense ?? 50)) / 2);
    const atk = mark.side === "attack";
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.strokeStyle = atk ? "rgba(61,154,106,0.35)" : "rgba(196,92,92,0.35)";
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = atk ? atkColor : defColor;
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
    const label = atk
      ? side === "up"
        ? "UPSIDE ATTACK CROSS"
        : "DOWNSIDE ATTACK CROSS"
      : side === "up"
        ? "UPSIDE DEFENSE CROSS"
        : "DOWNSIDE DEFENSE CROSS";
    ctx.textAlign = x > padL + plotW - 100 ? "right" : x < padL + 100 ? "left" : "center";
    ctx.fillText(label, Math.min(padL + plotW - 4, Math.max(padL + 4, x)), Math.max(padT + 9, y - 6));
  }

  drawPathMarkers(ctx, viz, { padL, padT, plotW, plotH, t0, t1, xAt, yAt, side });

  if (viz.hover.side === side && viz.hover.t != null && valid.length) {
    const hover = nearest(valid, viz.hover.t);
    if (hover) {
      const x = xAt(hover.t);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.strokeStyle = "rgba(232,234,239,0.28)";
      ctx.stroke();
      ctx.fillStyle = atkColor;
      ctx.beginPath();
      ctx.arc(x, yAt(hover.attack), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = defColor;
      ctx.beginPath();
      ctx.arc(x, yAt(hover.defense), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawSpread(viz, side) {
  const canvas = $(`bv-spread-${side}`);
  if (!canvas) return;
  const sideState = side === "up" ? viz.upside : viz.downside;
  const now = Date.now();
  const { t0, t1, rows } = samples(sideState, viz.chartWindow || 60, now);
  const { ctx, cssW, cssH } = sizeCanvas(canvas, 64);
  const padL = 28;
  const padR = 8;
  const padT = 6;
  const padB = 4;
  const plotW = Math.max(1, cssW - padL - padR);
  const plotH = Math.max(1, cssH - padT - padB);
  const xAt = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const yAt = (v) => padT + (1 - (clamp(v, -100, 100) + 100) / 200) * plotH;

  ctx.font = "8px IBM Plex Mono, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const level of [-100, -50, 0, 50, 100]) {
    const y = yAt(level);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.strokeStyle = level === 0 ? "rgba(232,234,239,0.28)" : "rgba(82,90,107,0.28)";
    ctx.setLineDash(level === 0 ? [] : [2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = level === 0 ? "#b4bac6" : "#525a6b";
    ctx.fillText(String(level), padL - 3, y);
  }

  ctx.fillStyle = "#525a6b";
  ctx.textAlign = "left";
  ctx.font = "8px IBM Plex Sans, sans-serif";
  ctx.fillText("ATTACK DOMINANT", padL + 4, yAt(50));
  ctx.fillText("DEFENSE DOMINANT", padL + 4, yAt(-50));

  const valid = rows.filter((r) => Number.isFinite(r.spread));
  if (valid.length >= 2) {
    ctx.beginPath();
    valid.forEach((p, i) => {
      const x = xAt(p.t);
      const y = yAt(p.spread);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#b4bac6";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // soft fill from zero
    ctx.beginPath();
    ctx.moveTo(xAt(valid[0].t), yAt(0));
    valid.forEach((p) => ctx.lineTo(xAt(p.t), yAt(p.spread)));
    ctx.lineTo(xAt(valid[valid.length - 1].t), yAt(0));
    ctx.closePath();
    ctx.fillStyle = "rgba(180,186,198,0.08)";
    ctx.fill();
  }
}

export function paintBattleViz(viz, modelLabel) {
  paintSummary("up", viz.upside, modelLabel);
  paintSummary("down", viz.downside, modelLabel);
  drawMain(viz, "up");
  drawMain(viz, "down");
  drawSpread(viz, "up");
  drawSpread(viz, "down");
}

/** Expose confirmed events for later backtest (display-layer store). */
export function battleVizEvents(viz) {
  return {
    upside: [...(viz.upside.events || [])].map((e) => ({
      ...e,
      channel: "UPSIDE",
      type:
        e.type === "ATTACK_CROSS"
          ? "UP_ATTACK_CROSS"
          : e.type === "DEFENSE_CROSS"
            ? "UP_DEFENSE_CROSS"
            : e.type === "SPREAD_EXPANDING"
              ? "UPSIDE_SPREAD_EXPANDING"
              : e.type,
    })),
    downside: [...(viz.downside.events || [])].map((e) => ({
      ...e,
      channel: "DOWNSIDE",
      type:
        e.type === "ATTACK_CROSS"
          ? "DOWN_ATTACK_CROSS"
          : e.type === "DEFENSE_CROSS"
            ? "DOWN_DEFENSE_CROSS"
            : e.type === "SPREAD_EXPANDING"
              ? "DOWNSIDE_SPREAD_EXPANDING"
              : e.type,
    })),
  };
}
