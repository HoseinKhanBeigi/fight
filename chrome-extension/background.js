/**
 * Service worker: manages offscreen lifecycle + badge / click handlers.
 * Alert persistence + notifications happen in offscreen.js (survives SW sleep).
 */

const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:8787/ws",
  uiUrl: "http://127.0.0.1:8787",
  enabled: true,
};

let status = "boot";

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function setStatus(next, detail = "") {
  status = next;
  chrome.storage.local.set({
    connectionStatus: next,
    connectionDetail: detail,
    connectionAt: Date.now(),
  });
  paintBadge(next);
}

function paintBadge(next, side) {
  if (side === "buy") {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#2a9d5c" });
    return;
  }
  if (side === "sell") {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c45c3e" });
    return;
  }
  const badge = next === "LIVE" ? "ON" : next === "OFF" ? "" : "!";
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({
    color: next === "LIVE" ? "#2a9d5c" : "#c45c3e",
  });
}

async function hasOffscreen() {
  if (!chrome.offscreen?.hasDocument) return false;
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Keep a persistent WebSocket for aggression alerts while the service worker sleeps.",
  });
}

async function tellOffscreenConnect() {
  const cfg = await settings();
  await ensureOffscreen();
  // Give offscreen a tick to register its listener after createDocument
  await new Promise((r) => setTimeout(r, 50));
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "connect",
      wsUrl: cfg.wsUrl,
      enabled: !!cfg.enabled,
    });
  } catch (err) {
    setStatus("ERR", String(err?.message || err));
  }
}

function fmtUsd(n) {
  const a = Math.abs(Number(n) || 0);
  if (a >= 1_000_000) return `$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `$${(a / 1_000).toFixed(0)}K`;
  return `$${a.toFixed(0)}`;
}

/** Test button only — real alerts are handled in offscreen. */
async function showTestAlert() {
  const alert = {
    message: "TEST · Fight Aggression Alerts",
    symbol: "TESTUSDT",
    label: "TEST",
    side: "buy",
    windowSec: 30,
    triggerUsd: 500_000,
  };
  const title = alert.message;
  const body = `${alert.symbol} · ${alert.windowSec}s · ${fmtUsd(alert.triggerUsd)}`;
  const id = `test-${Date.now()}`;
  const entry = { id, title, body, ts: Date.now(), symbol: alert.symbol, side: "BUY" };
  const prev = await chrome.storage.local.get({ recentAlerts: [] });
  await chrome.storage.local.set({
    recentAlerts: [entry, ...(prev.recentAlerts || [])].slice(0, 40),
    lastAlertAt: entry.ts,
  });
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message: body,
    priority: 2,
  });
  paintBadge("LIVE", "buy");
}

chrome.notifications.onClicked.addListener(async (id) => {
  const { uiUrl } = await settings();
  chrome.tabs.create({ url: uiUrl });
  chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.source === "offscreen") {
    if (msg.type === "ready") {
      tellOffscreenConnect().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "status") {
      setStatus(msg.status, msg.detail || "");
      return;
    }
    if (msg.type === "aggressionAlert") {
      // Already stored + notified by offscreen; just update badge
      const side = String(msg.payload?.side || "").toLowerCase();
      paintBadge("LIVE", side === "buy" ? "buy" : "sell");
      return;
    }
  }

  if (msg?.type === "getStatus") {
    chrome.storage.local
      .get(["connectionStatus", "connectionDetail", "recentAlerts", "lastAlertAt"])
      .then((s) => {
        sendResponse({
          status: s.connectionStatus || status,
          detail: s.connectionDetail || "",
          recentAlerts: s.recentAlerts || [],
          lastAlertAt: s.lastAlertAt || 0,
        });
      });
    return true;
  }

  if (msg?.type === "reconnect") {
    tellOffscreenConnect()
      .then(async () => {
        // Wait briefly for LIVE status from offscreen
        await new Promise((r) => setTimeout(r, 400));
        const s = await chrome.storage.local.get(["connectionStatus", "connectionDetail"]);
        sendResponse({
          status: s.connectionStatus || status,
          detail: s.connectionDetail || "",
        });
      })
      .catch((err) => sendResponse({ status: "ERR", detail: String(err) }));
    return true;
  }

  if (msg?.type === "testNotify") {
    showTestAlert()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.wsUrl || changes.enabled || changes.uiUrl) {
    tellOffscreenConnect();
  }
  if (changes.pendingBadge) {
    const side = changes.pendingBadge.newValue;
    if (side === "buy" || side === "sell") paintBadge("LIVE", side);
  }
  if (changes.connectionStatus) {
    status = changes.connectionStatus.newValue;
    paintBadge(status);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set(DEFAULTS);
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  await tellOffscreenConnect();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  await tellOffscreenConnect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") tellOffscreenConnect();
});

tellOffscreenConnect();
