/**
 * Service worker: keeps offscreen WebSocket alive + shows Chrome notifications.
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

async function showAlert(alert) {
  const side = String(alert.side || "").toUpperCase();
  const title = alert.message || `${alert.label || alert.symbol} ${side}`;
  const body = `${alert.symbol} · ${alert.windowSec || "—"}s · ${fmtUsd(alert.triggerUsd)}`;
  // Chrome notification IDs must be reasonable; avoid odd chars
  const id = `agg-${String(alert.symbol || "x")}-${side}-${Date.now()}`.replace(
    /[^a-zA-Z0-9_-]/g,
    ""
  );

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
  } catch (err) {
    console.error("notification failed", err);
    // Fallback without requireInteraction
    try {
      await chrome.notifications.create(id + "-b", {
        type: "basic",
        iconUrl,
        title: title.slice(0, 120),
        message: body.slice(0, 250),
      });
    } catch (err2) {
      console.error("notification fallback failed", err2);
      setStatus("LIVE", `notify fail: ${err2?.message || err2}`);
    }
  }

  const prev = await chrome.storage.local.get({ recentAlerts: [] });
  const recentAlerts = [
    { id, title, body, ts: Date.now(), symbol: alert.symbol, side },
    ...(prev.recentAlerts || []),
  ].slice(0, 12);
  await chrome.storage.local.set({ recentAlerts, lastAlertAt: Date.now() });

  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({
    color: side === "BUY" ? "#2a9d5c" : "#c45c3e",
  });
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
    if (msg.type === "aggressionAlert" && msg.payload) {
      showAlert(msg.payload);
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
    showAlert({
      message: "TEST · Fight Aggression Alerts",
      symbol: "TESTUSDT",
      label: "TEST",
      side: "buy",
      windowSec: 30,
      triggerUsd: 500_000,
      id: `test-${Date.now()}`,
    }).then(() => sendResponse({ ok: true }));
    return true;
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.wsUrl || changes.enabled || changes.uiUrl) {
    tellOffscreenConnect();
  }
});

tellOffscreenConnect();
