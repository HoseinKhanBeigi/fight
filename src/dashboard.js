/**
 * Terminal dashboard for the order-flow monitor.
 * Uses ANSI clears — no API key, no extra UI deps.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";

function fmt(n, d = 3) {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(1);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(d);
  if (abs >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function pct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function pad(s, w, align = "left") {
  const str = String(s);
  if (str.length >= w) return str.slice(0, w);
  const space = " ".repeat(w - str.length);
  return align === "right" ? space + str : str + space;
}

function line(char = "─", width = 78) {
  return DIM + char.repeat(width) + RESET;
}

function header(title) {
  return `${BOLD}${CYAN}${title}${RESET}`;
}

function signed(n, d = 3) {
  if (n == null || Number.isNaN(n)) return "—";
  const s = fmt(n, d);
  if (n > 0) return `${GREEN}+${s}${RESET}`;
  if (n < 0) return `${RED}${s}${RESET}`;
  return s;
}

function stateColor(state) {
  if (!state) return WHITE;
  if (state.includes("BUY") || state.includes("ASK PULL") || state.includes("UPSIDE") || state.includes("TRUE ASK"))
    return GREEN;
  if (state.includes("SELL") || state.includes("BID PULL") || state.includes("DOWNSIDE") || state.includes("TRUE BID"))
    return RED;
  if (state.includes("ABSORPTION")) return YELLOW;
  if (state.includes("WALL")) return MAGENTA;
  return WHITE;
}

function battleBlock(title, b, aggressorLabel, passiveLabel) {
  const rows = [
    header(title),
    `${aggressorLabel}`,
    `        ↓`,
    `${passiveLabel}`,
    "",
    `Aggressive Vol:   ${pad(fmt(b.aggressiveVolume), 12, "right")} BTC`,
    `Passive Liq:      ${pad(fmt(b.passiveLiquidity), 12, "right")} BTC`,
    `Executed:         ${pad(fmt(b.executed), 12, "right")} BTC`,
    `Cancelled (est.): ${pad(fmt(b.cancelled), 12, "right")} BTC`,
    `Refill (est.):    ${pad(fmt(b.refill), 12, "right")} BTC`,
    "",
    `Execution Ratio:     ${pct(b.executionRatio)}`,
    `Cancellation Ratio:  ${pct(b.cancellationRatio)}`,
    `Refill Ratio:        ${pct(b.refillRatio)}`,
    `Attack Score:        ${fmt(b.attackScore, 2)}`,
    "",
    `Result: ${stateColor(b.result)}${BOLD}${b.result}${RESET}`,
  ];
  return rows;
}

function wallBlock(label, wall) {
  if (!wall) {
    return [header(label), DIM + "  (no wall detected)" + RESET];
  }
  const status =
    wall.status === "WALL_PULLED"
      ? `${MAGENTA}WALL PULLED — NOT SWEPT${RESET}`
      : wall.status === "SWEPT"
        ? `${GREEN}SWEPT${RESET}`
        : wall.status;
  return [
    header(label),
    `Price:           ${fmt(wall.price, 2)}`,
    `Initial Size:    ${fmt(wall.initialSize)} BTC`,
    `Current Size:    ${fmt(wall.currentSize)} BTC`,
    `Executed:        ${fmt(wall.executedVolume)} BTC`,
    `Cancelled (est.):${fmt(wall.cancelledVolume)} BTC`,
    `Refilled (est.): ${fmt(wall.refilledVolume)} BTC`,
    `Execution Ratio: ${pct(wall.executionRatio)}`,
    `Cancel Ratio:    ${pct(wall.cancelRatio)}`,
    `Lifetime:        ${fmt(wall.lifetimeMs / 1000, 1)}s`,
    `Status:          ${status}`,
  ];
}

export class Dashboard {
  constructor(monitor, refreshHz = 4) {
    this.monitor = monitor;
    this.refreshMs = Math.max(100, Math.floor(1000 / refreshHz));
    this.timer = null;
    this.hidden = false;
  }

  start() {
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.timer = setInterval(() => this.render(), this.refreshMs);
    this.render();

    const restore = () => {
      process.stdout.write("\x1b[?25h");
      this.stop();
    };
    process.on("SIGINT", () => {
      restore();
      this.monitor.stop();
      process.exit(0);
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    process.stdout.write("\x1b[?25h");
  }

  render() {
    const s = this.monitor.snapshot();
    const windows = this.monitor.config.windows;
    const lines = [];

    lines.push(line("═"));
    lines.push(
      `${BOLD}${WHITE}${s.symbol}${RESET}  Order-Flow Monitor  ${DIM}${s.ready ? "LIVE" : "SYNCING…"}${RESET}  ${DIM}${s.status}${RESET}`
    );
    lines.push(line("═"));

    lines.push(
      `Price ${BOLD}${fmt(s.price, 2)}${RESET}   Bid ${GREEN}${fmt(s.bestBid, 2)}${RESET} x ${fmt(s.bestBidQty)}   Ask ${RED}${fmt(s.bestAsk, 2)}${RESET} x ${fmt(s.bestAskQty)}   Spread ${fmt(s.spread, 2)}`
    );
    lines.push(
      `Tick ${fmt(s.tickSize, 4)}   Δprice 5s ${signed(s.priceChangeTicks5s, 1)} ticks`
    );
    lines.push("");

    // Aggressive flow table
    lines.push(header("AGGRESSIVE FLOW"));
    const cols = windows.map((w) => pad(`${w}s`, 10, "right")).join("");
    lines.push(`${pad("", 14)}${cols}`);
    const row = (label, getter, colorFn = (x) => x) => {
      let r = pad(label, 14);
      for (const w of windows) {
        const st = s.flowWindows[w];
        r += pad(colorFn(fmt(getter(st))), 10, "right");
      }
      return r;
    };
    lines.push(row("Buy Volume", (st) => st.aggressiveBuyVolume));
    lines.push(row("Sell Volume", (st) => st.aggressiveSellVolume));
    lines.push(
      (() => {
        let r = pad("Delta", 14);
        for (const w of windows) {
          r += pad(signed(s.flowWindows[w].netDelta), 10 + 9, "right"); // account for ansi roughly
          // simpler without padding ansi:
        }
        return r;
      })()
    );
    // Fix delta row without broken padding
    lines.pop();
    {
      let r = pad("Delta", 14);
      for (const w of windows) {
        const d = s.flowWindows[w].netDelta;
        const plain = (d >= 0 ? "+" : "") + fmt(d);
        r += " ".repeat(Math.max(1, 10 - plain.length)) + signed(d);
      }
      lines.push(r);
    }
    {
      let r = pad("Buy %", 14);
      for (const w of windows) r += pad(pct(s.flowWindows[w].buyRatio), 10, "right");
      lines.push(r);
    }
    {
      let r = pad("Sell %", 14);
      for (const w of windows) r += pad(pct(s.flowWindows[w].sellRatio), 10, "right");
      lines.push(r);
    }
    lines.push("");

    // Passive liquidity
    lines.push(header("PASSIVE LIQUIDITY (near book)"));
    lines.push(
      `Bid Liquidity ${fmt(s.bidLiquidity)} BTC    Ask Liquidity ${fmt(s.askLiquidity)} BTC`
    );
    {
      const L = s.liqWindows[5] || s.liqWindows[15] || {};
      lines.push(
        `Bid Stack ${fmt(L.bidStack)}   Ask Stack ${fmt(L.askStack)}   Bid Refill ${fmt(L.bidRefill)}   Ask Refill ${fmt(L.askRefill)}`
      );
      lines.push(
        `Bid Cancel (est.) ${fmt(L.bidCancel)}   Ask Cancel (est.) ${fmt(L.askCancel)}`
      );
      lines.push(
        `Bid Exec Ratio ${pct(L.bidExecRatio)}   Ask Exec Ratio ${pct(L.askExecRatio)}   Bid Cancel Ratio ${pct(L.bidCancelRatio)}   Ask Cancel Ratio ${pct(L.askCancelRatio)}`
      );
      lines.push(
        `Passive Pressure  Bid ${signed(L.bidPassivePressure)}   Ask ${signed(L.askPassivePressure)}`
      );
    }
    lines.push("");

    // Cancellation panel
    lines.push(header("LIQUIDITY CANCELLATIONS (estimated)"));
    lines.push(`${pad("", 16)}${pad("BID", 12, "right")}${pad("ASK", 12, "right")}`);
    for (const w of windows) {
      const L = s.liqWindows[w] || {};
      lines.push(
        `${pad(`Cancelled ${w}s`, 16)}${pad(fmt(L.bidCancel), 12, "right")}${pad(fmt(L.askCancel), 12, "right")}`
      );
    }
    {
      const L = s.liqWindows[5] || {};
      lines.push(
        `${pad("Cancel Ratio", 16)}${pad(pct(L.bidCancelRatio), 12, "right")}${pad(pct(L.askCancelRatio), 12, "right")}`
      );
      lines.push(
        `${pad("Pulling", 16)}${pad(s.pulling.bid, 12, "right")}${pad(s.pulling.ask, 12, "right")}`
      );
      lines.push(
        `${pad("Stacking", 16)}${pad(s.stacking.bid, 12, "right")}${pad(s.stacking.ask, 12, "right")}`
      );
      lines.push(`Cancellation Imbalance: ${BOLD}${s.cancelImbalanceLabel}${RESET}`);
    }
    lines.push("");

    const pm = s.preMove?.current;
    if (pm) {
      lines.push(header("PRE-MOVE PRESSURE"));
      lines.push(
        `Up ${pm.upPressure}/100 (${String(pm.upTrend || "").replace(/_/g, " ")})   Down ${pm.downPressure}/100 (${String(pm.downTrend || "").replace(/_/g, " ")})   Imb ${signed(pm.pressureImbalance, 0)}`
      );
      lines.push(
        `State ${BOLD}${pm.state}${RESET}   Conf ${pm.confidence}/100   Align ${s.preMove.alignment?.score ?? "—"}/100`
      );
      if (pm.why?.length) {
        for (const line of pm.why.slice(0, 4)) lines.push(`  ${DIM}– ${line}${RESET}`);
      }
      lines.push("");
    }

    // Battles side by side (stacked vertically for terminal width)
    lines.push(...battleBlock("BUY SIDE BATTLE", s.buyBattle, "Aggressive Buyers", "Passive Sellers (Asks)"));
    lines.push("");
    lines.push(...battleBlock("SELL SIDE BATTLE", s.sellBattle, "Aggressive Sellers", "Passive Buyers (Bids)"));
    lines.push("");

    // Walls
    lines.push(...wallBlock("ASK WALL", s.largestAskWall));
    lines.push("");
    lines.push(...wallBlock("BID WALL", s.largestBidWall));
    lines.push("");

    lines.push(header("CURRENT STATE"));
    lines.push(`  ${stateColor(s.state)}${BOLD}${s.state}${RESET}`);
    if (s.pendingState) {
      lines.push(`  ${DIM}pending → ${s.pendingState}${RESET}`);
    }
    lines.push("");
    lines.push(`${DIM}${s.note}${RESET}`);
    lines.push(`${DIM}Ctrl+C to quit${RESET}`);

    // Clear screen + home
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
  }
}
