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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(__dirname, "..", "ui");

const args = process.argv.slice(2).filter((a) => a !== "--mock");
const portArg = args.find((a) => a.startsWith("--port="));
const port = portArg
  ? Number(portArg.split("=")[1])
  : args.includes("--port")
    ? Number(args[args.indexOf("--port") + 1])
    : 8787;
const symbolArg = args.find((a) => !a.startsWith("--") && a !== String(port));
let symbol = (symbolArg || CONFIG.symbol).toLowerCase();
let switching = false;
let switchQueue = Promise.resolve();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" || ext === ".js" || ext === ".css" ? "no-store" : "public",
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(UI_ROOT, pathname));
  if (!filePath.startsWith(UI_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(res, filePath);
});

const wss = new WebSocketServer({ server, path: "/ws" });

let monitor = null;
let broadcastTimer = null;
let tickerTimer = null;

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(raw);
  }
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
  });
});

server.listen(port, async () => {
  console.log(`Order-flow UI  →  http://localhost:${port}`);
  console.log(`Live symbol    →  ${symbol.toUpperCase()} (real Binance Futures data)`);
  await startMonitor(symbol);
  startBroadcast();
});

process.on("SIGINT", () => {
  if (monitor) monitor.stop();
  server.close();
  process.exit(0);
});
