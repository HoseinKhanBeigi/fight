/**
 * Audits the "Aggressive buyers -> Passive asks" card against its own maths.
 *
 * Usage: node scripts/check-fight-card.mjs [port]
 */

import WebSocket from "ws";

const port = process.argv[2] || "8787";
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const usdFmt = (n) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;

const timer = setTimeout(() => {
  console.error("No snapshot received");
  process.exit(1);
}, 20000);

ws.on("message", (buf) => {
  const msg = JSON.parse(buf.toString());
  const s = msg.type === "snapshot" ? msg.payload : msg;
  if (!s?.flowWindows) return;
  clearTimeout(timer);
  ws.close();

  const px = s.price;
  const usd = (q) => (q || 0) * px;

  console.log(`\n${s.symbol}  price ${px}`);
  console.log(`Ask liq (snapshot, top-20): ${usdFmt(usd(s.askLiquidity))}`);
  console.log(`Bid liq (snapshot, top-20): ${usdFmt(usd(s.bidLiquidity))}`);
  console.log(`Book history collected: ${Math.round(s.bookCoverageSec ?? -1)}s\n`);

  for (const w of [60, 300, 900, 1800, 2700]) {
    const f = s.flowWindows[w] || s.flowWindows[String(w)];
    const l = s.liqWindows[w] || s.liqWindows[String(w)];
    if (!f) continue;
    const a =
      (s.absorptionByWindow || {})[w] || (s.absorptionByWindow || {})[String(w)] || {};

    const aggBuy = f.aggressiveBuyVolume || 0;
    const askExec = l?.askExec || 0;
    const askCancel = l?.askCancel || 0;
    const askRefill = l?.askRefill || 0;

    const minFormula = Math.min(aggBuy, askExec, askRefill);
    const engineAbs = a.askAbsorbedVolume ?? a.aggressiveBuyAbsorbedVolume ?? null;
    const shown = engineAbs != null ? engineAbs : minFormula;

    const perMin = (aggBuy / w) * 60;
    const attack = perMin / Math.max(s.askLiquidity || 0, 1e-9);
    const execR = askExec + askCancel > 0 ? askExec / (askExec + askCancel) : 0;
    const refR = askExec > 0 ? askRefill / askExec : 0;
    const attackTerm = 0.5 * Math.max(0, Math.min(1, attack));
    const force = Math.max(
      0.05,
      Math.min(0.95, attackTerm + 0.35 * Math.min(1, execR) + 0.15 * (1 - Math.min(1, refR)))
    );

    console.log(`--- ${w}s window ---`);
    console.log(`  Aggressive (trade feed) ${usdFmt(usd(aggBuy))}`);
    console.log(`  Executed   (book delta) ${usdFmt(usd(askExec))}`);
    console.log(`  ratio aggressive/executed: ${(aggBuy / Math.max(askExec, 1e-9)).toFixed(2)}x  (should be ~1)`);
    console.log(`  Cancelled ${usdFmt(usd(askCancel))}   Refilled ${usdFmt(usd(askRefill))}`);
    console.log(
      `  Absorbed shown ${usdFmt(usd(shown))} | hint formula min() ${usdFmt(usd(minFormula))} | ` +
        `${engineAbs != null ? (Math.abs(engineAbs - minFormula) < 1e-9 ? "match" : "HINT MISMATCH") : "min() used"}`
    );
    console.log(
      `  attackScore ${attack.toFixed(4)} (book/min) -> ${(attackTerm * 100).toFixed(2)}pp of its 50pp budget`
    );
    console.log(`  meter force ${Math.round(force * 100)}%${force <= 0.0501 ? "  (pinned at 5% floor)" : ""}`);
  }
  console.log("");
});

ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(1);
});
