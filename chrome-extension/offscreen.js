/**
 * Persistent WebSocket host (offscreen document).
 * Handles alerts HERE so they are not lost when the service worker sleeps.
 */

let ws = null;
let reconnectTimer = null;
let gen = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "connect") {
    connect(msg.wsUrl, msg.enabled !== false);
  }
  if (msg.type === "disconnect") {
    gen += 1;
    closeSocket();
    writeStatus("OFF", "");
  }
});

function writeStatus(status, detail = "") {
  chrome.storage.local.set({
    connectionStatus: status,
    connectionDetail: detail,
    connectionAt: Date.now(),
  });
  chrome.runtime
    .sendMessage({ source: "offscreen", type: "status", status, detail })
    .catch(() => {});
}

function fmtUsd(n) {
  const a = Math.abs(Number(n) || 0);
  if (a >= 1_000_000) return `$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `$${(a / 1_000).toFixed(0)}K`;
  return `$${a.toFixed(0)}`;
}

async function handleAlert(alert) {
  const side = String(alert.side || "").toUpperCase();
  const title = alert.message || `${alert.label || alert.symbol} ${side}`;
  const body = `${alert.symbol} · ${alert.windowSec || "—"}s · ${fmtUsd(alert.triggerUsd)}`;
  const id = `agg-${String(alert.symbol || "x")}-${side}-${Date.now()}`.replace(
    /[^a-zA-Z0-9_-]/g,
    ""
  );
  const entry = {
    id,
    title,
    body,
    ts: Date.now(),
    symbol: alert.symbol,
    side,
    triggerUsd: alert.triggerUsd,
  };

  // Persist first — popup reads this directly
  const prev = await chrome.storage.local.get({ recentAlerts: [] });
  const recentAlerts = [entry, ...(prev.recentAlerts || [])].slice(0, 40);
  await chrome.storage.local.set({
    recentAlerts,
    lastAlertAt: entry.ts,
    pendingBadge: side === "BUY" ? "buy" : "sell",
  });

  const iconUrl = chrome.runtime.getURL("icons/icon128.png");
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl,
      title: title.slice(0, 120),
      message: body.slice(0, 250),
      priority: 2,
      requireInteraction: true,
    });
  } catch {
    try {
      await chrome.notifications.create(`${id}b`, {
        type: "basic",
        iconUrl,
        title: title.slice(0, 120),
        message: body.slice(0, 250),
      });
    } catch (err) {
      console.error("notify failed", err);
    }
  }

  // Best-effort wake SW for badge update
  chrome.runtime
    .sendMessage({ source: "offscreen", type: "aggressionAlert", payload: alert, stored: true })
    .catch(() => {});
}

function closeSocket() {
  if (!ws) return;
  const sock = ws;
  ws = null;
  try {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onerror = null;
    sock.onclose = null;
    sock.close();
  } catch {
    /* ignore */
  }
}

function scheduleReconnect(wsUrl, enabled, ms = 2500) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(wsUrl, enabled), ms);
}

function connect(wsUrl, enabled) {
  const myGen = ++gen;
  if (!enabled) {
    closeSocket();
    writeStatus("OFF", "");
    return;
  }
  if (!wsUrl) {
    writeStatus("ERR", "missing wsUrl");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    writeStatus("LIVE", wsUrl);
    return;
  }

  closeSocket();
  writeStatus("CONNECTING", wsUrl);

  let sock;
  try {
    sock = new WebSocket(wsUrl);
  } catch (err) {
    writeStatus("ERR", String(err?.message || err));
    scheduleReconnect(wsUrl, enabled);
    return;
  }
  ws = sock;

  const timer = setTimeout(() => {
    if (myGen !== gen) return;
    try {
      sock.close();
    } catch {
      /* ignore */
    }
    writeStatus("ERR", "timeout — is fight server running?");
    scheduleReconnect(wsUrl, enabled);
  }, 8000);

  sock.onopen = () => {
    if (myGen !== gen) return;
    clearTimeout(timer);
    writeStatus("LIVE", wsUrl);
  };

  sock.onmessage = (ev) => {
    if (myGen !== gen) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "aggressionAlert" && msg.payload) {
      handleAlert(msg.payload);
    }
  };

  sock.onerror = () => {
    writeStatus("ERR", "WebSocket error — check Local network access");
  };

  sock.onclose = () => {
    clearTimeout(timer);
    if (myGen !== gen) return;
    if (ws === sock) ws = null;
    writeStatus("DOWN", "disconnected");
    scheduleReconnect(wsUrl, enabled);
  };
}

chrome.runtime.sendMessage({ source: "offscreen", type: "ready" }).catch(() => {});
