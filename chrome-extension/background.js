/**
 * Service worker: storage + notifications + offscreen lifecycle.
 */

const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:8787/ws",
  uiUrl: "http://127.0.0.1:8787",
  enabled: true,
};

let status = "boot";

function storageLocal() {
  try {
    return chrome?.storage?.local ?? null;
  } catch {
    return null;
  }
}

async function settings() {
  const local = storageLocal();
  if (!local) return { ...DEFAULTS };
  try {
    const stored = await local.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

async function storeSet(obj) {
  const local = storageLocal();
  if (!local) return false;
  try {
    await local.set(obj);
    return true;
  } catch (err) {
    console.error("storage.set failed", err);
    return false;
  }
}

async function storeGet(defaults) {
  const local = storageLocal();
  if (!local) return { ...defaults };
  try {
    return await local.get(defaults);
  } catch {
    return { ...defaults };
  }
}

function setStatus(next, detail = "") {
  status = next;
  storeSet({
    connectionStatus: next,
    connectionDetail: detail,
    connectionAt: Date.now(),
  });
  paintBadge(next);
}

function paintBadge(next, side) {
  try {
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
  } catch (err) {
    console.error("badge failed", err);
  }
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
  await new Promise((r) => setTimeout(r, 80));
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

  const prev = await storeGet({ recentAlerts: [] });
  await storeSet({
    recentAlerts: [entry, ...(prev.recentAlerts || [])].slice(0, 40),
    lastAlertAt: entry.ts,
  });

  const iconUrl = chrome.runtime.getURL("icons/icon128.png");
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl,
      title: String(title).slice(0, 120),
      message: String(body).slice(0, 250),
      priority: 2,
      requireInteraction: true,
    });
  } catch (err) {
    console.error("notification failed", err);
    try {
      await chrome.notifications.create(`${id}b`, {
        type: "basic",
        iconUrl,
        title: String(title).slice(0, 120),
        message: String(body).slice(0, 250),
      });
    } catch (err2) {
      console.error("notification fallback failed", err2);
    }
  }

  paintBadge("LIVE", side === "BUY" ? "buy" : "sell");
}

chrome.notifications.onClicked.addListener(async (nid) => {
  const { uiUrl } = await settings();
  chrome.tabs.create({ url: uiUrl });
  chrome.notifications.clear(nid);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.source === "offscreen") {
    if (msg.type === "ready") {
      tellOffscreenConnect().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "status") {
      setStatus(msg.status, msg.detail || "");
      sendResponse?.({ ok: true });
      return true;
    }
    if (msg.type === "aggressionAlert" && msg.payload) {
      showAlert(msg.payload)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
  }

  if (msg?.type === "getStatus") {
    storeGet({
      connectionStatus: status,
      connectionDetail: "",
      recentAlerts: [],
      lastAlertAt: 0,
    }).then((s) => {
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
        await new Promise((r) => setTimeout(r, 400));
        const s = await storeGet({ connectionStatus: status, connectionDetail: "" });
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
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.wsUrl || changes.enabled || changes.uiUrl) {
    tellOffscreenConnect();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await storeSet(DEFAULTS);
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
