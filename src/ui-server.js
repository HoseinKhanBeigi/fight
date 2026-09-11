#!/usr/bin/env node
/**
 * Serves the footprint dashboard and streams LIVE OrderFlowMonitor snapshots.
 *
 *   npm run ui
 *   node src/ui-server.js ethusdt --port 8787
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { CONFIG } from "./config.js";
import { OrderFlowMonitor } from "./monitor.js";
import {
  CRYPTO_WATCHLIST,
  EQUITY_WATCHLIST,
  WATCHLIST,
} from "./watchlist.js";
import { WatchlistAggressionWatcher } from "./aggression-watch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(path.join(__dirname, "..", "ui"));

const args = process.argv.slice(2).filter((a) => a !== "--mock");
const portArg = args.find((a) => a.startsWith("--port="));
const port = Number(
  process.env.PORT ||
    (portArg
      ? portArg.split("=")[1]
      : args.includes("--port")
        ? args[args.indexOf("--port") + 1]
        : 8787)
);
const symbolArg = args.find((a) => !a.startsWith("--") && a !== String(port));
let symbol = (process.env.SYMBOL || symbolArg || CONFIG.symbol).toLowerCase();
let switching = false;
let switchQueue = Promise.resolve();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // Chrome DevTools probes this path; keep logs quiet for known noise.
      if (!String(filePath).includes("/.well-known/")) {
        console.error("Static 404:", filePath, err.code);
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control":
        ext === ".html" || ext === ".js" || ext === ".css" ? "no-store" : "public",
    });
    res.end(buf);
  });
}

function resolveUiPath(pathname) {
  let rel = decodeURIComponent(pathname || "/");
  if (rel === "/" || rel === "") rel = "index.html";
  // Never pass an absolute segment into path.join
  rel = rel.replace(/^\/+/, "");
  const filePath = path.resolve(UI_ROOT, rel);
  const rootWithSep = UI_ROOT.endsWith(path.sep) ? UI_ROOT : UI_ROOT + path.sep;
  if (filePath !== UI_ROOT && !filePath.startsWith(rootWithSep)) {
    return null;
  }
  return filePath;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          symbol: symbol.toUpperCase(),
          ready: !!monitor?.ready,
        })
      );
      return;
    }
    if (url.pathname === "/api/watchlist") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          crypto: CRYPTO_WATCHLIST,
          equity: EQUITY_WATCHLIST,
          coins: WATCHLIST,
        })
      );
      return;
    }
    // Ignore websocket upgrade here; ws library handles /ws
    if (url.pathname === "/ws") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("WebSocket endpoint");
      return;
    }
    const filePath = resolveUiPath(url.pathname);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    sendFile(res, filePath);
  } catch (err) {
    console.error("HTTP handler error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

let monitor = null;
let broadcastTimer = null;
let tickerTimer = null;
let aggressionWatch = null;
let aggressionStatusTimer = null;

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(raw);
  }
}

function startAggressionWatch() {
  if (aggressionWatch) return;
  aggressionWatch = new WatchlistAggressionWatcher({
    thresholdUsd: 500_000,
    windowSec: 5,
    exclude: new Set(),
    onAlert: (alert) => {
      let clients = 0;
      for (const c of wss.clients) if (c.readyState === 1) clients += 1;
      console.log(`[ALERT] ${alert.message} → UI clients: ${clients}`);
      broadcast({ type: "aggressionAlert", payload: alert });
    },
    onStatus: (msg) => {
      broadcast({ type: "aggressionWatchStatus", payload: { status: msg } });
    },
  });
  aggressionWatch.start();
  if (aggressionStatusTimer) clearInterval(aggressionStatusTimer);
  aggressionStatusTimer = setInterval(() => {
    if (!aggressionWatch) return;
    broadcast({ type: "aggressionWatch", payload: aggressionWatch.snapshot() });
  }, 2000);
  console.log(
    `Aggression watch → ${aggressionWatch.watchedSymbols().join(", ")} (5s > $500K)`
  );
}

async function fetch24h(sym) {
  try {
    const url = `${CONFIG.restBase}/fapi/v1/ticker/24hr?symbol=${sym.toUpperCase()}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const j = await res.json();
    broadcast({
      type: "ticker24h",
      payload: {
        priceChangePercent: Number(j.priceChangePercent),
        highPrice: Number(j.highPrice),
        lowPrice: Number(j.lowPrice),
        volume: Number(j.volume),
        quoteVolume: Number(j.quoteVolume),
      },
    });
  } catch {
    /* ignore */
  }
}

async function startMonitor(sym) {
  const next = String(sym || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "");
  if (!next) return;

  switchQueue = switchQueue
    .then(() => _startMonitor(next))
    .catch((err) => {
      console.error("Symbol switch failed:", err);
      switching = false;
      broadcast({
        type: "status",
        connection: "DISCONNECTED",
        status: `Failed to switch: ${err.message}`,
      });
    });
  await switchQueue;
}

async function _startMonitor(next) {
  if (next === symbol && monitor) return;

  switching = true;
  if (monitor) {
    try {
      monitor.stop();
    } catch {
      /* ignore */
    }
    monitor = null;
  }

  symbol = next;
  console.log(`Live feed → ${symbol.toUpperCase()}`);

  monitor = new OrderFlowMonitor({
    ...CONFIG,
    symbol,
  });

  broadcast({
    type: "status",
    connection: "RECONNECTING",
    status: `Starting live feed for ${symbol.toUpperCase()}`,
  });

  broadcast({
    type: "snapshot",
    payload: {
      ...monitor.snapshot(),
      symbol: symbol.toUpperCase(),
      connection: "RECONNECTING",
      ready: false,
      footprint: {
        intervalSec: monitor.footprint.intervalSec,
        columns: [],
        prices: [],
        maxVol: 1,
        lastPrice: null,
      },
    },
  });

  await monitor.start();
  await fetch24h(symbol);
  switching = false;
}

function startBroadcast() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  broadcastTimer = setInterval(() => {
    if (!monitor || switching) return;
    const payload = monitor.snapshot();
    broadcast({ type: "snapshot", payload });
  }, 250);

  if (tickerTimer) clearInterval(tickerTimer);
  tickerTimer = setInterval(() => fetch24h(symbol), 15_000);
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "status",
      connection: monitor?.ready ? "LIVE" : "RECONNECTING",
      status: monitor?.status || "Waiting for feed",
    })
  );
  if (monitor) {
    ws.send(JSON.stringify({ type: "snapshot", payload: monitor.snapshot() }));
  }
  if (aggressionWatch) {
    ws.send(
      JSON.stringify({ type: "aggressionWatch", payload: aggressionWatch.snapshot() })
    );
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "setSymbol" && msg.symbol) {
      const next = String(msg.symbol).toLowerCase().trim();
      if (next && next !== symbol) {
        try {
          await startMonitor(next);
        } catch (err) {
          console.error("Symbol switch failed:", err);
          switching = false;
          broadcast({
            type: "status",
            connection: "DISCONNECTED",
            status: `Failed to switch to ${next}: ${err.message}`,
          });
        }
      }
    }

    if (msg.type === "setFootprintInterval" && monitor && msg.intervalSec) {
      monitor.setFootprintInterval(msg.intervalSec);
    }

    if (msg.type === "setPreMoveWindow" && monitor && msg.windowSec) {
      monitor.setPreMoveWindow(msg.windowSec);
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`UI folder      →  ${UI_ROOT}`);
  console.log(`Listening      →  0.0.0.0:${port}`);
  console.log(`Health check   →  http://0.0.0.0:${port}/health`);
  console.log(`Live symbol    →  ${symbol.toUpperCase()} (real Binance Futures data)`);
  if (!fs.existsSync(path.join(UI_ROOT, "index.html"))) {
    console.error("ERROR: ui/index.html missing at", path.join(UI_ROOT, "index.html"));
  }
  // Start market data after HTTP is already accepting traffic (Railway health checks)
  startAggressionWatch();
  startMonitor(symbol)
    .then(() => startBroadcast())
    .catch((err) => {
      console.error("Failed to start monitor (HTTP still up):", err);
      setTimeout(() => {
        startMonitor(symbol)
          .then(() => startBroadcast())
          .catch((e) => console.error("Monitor retry failed:", e));
      }, 5000);
    });
});

process.on("SIGTERM", () => {
  if (aggressionWatch) aggressionWatch.stop();
  if (monitor) monitor.stop();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  if (aggressionWatch) aggressionWatch.stop();
  if (monitor) monitor.stop();
  server.close();
  process.exit(0);
});
