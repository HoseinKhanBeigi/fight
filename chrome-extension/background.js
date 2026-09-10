/**
 * Connects to fight UI WebSocket and shows Chrome notifications on aggressionAlert.
 */

const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:8787/ws",
  uiUrl: "http://127.0.0.1:8787",
  enabled: true,
};

/** @type {WebSocket|null} */
let ws = null;
let reconnectTimer = null;
let connectGen = 0;
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

function scheduleReconnect(ms = 2500) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect().catch(() => {});
  }, ms);
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

/**
 * @returns {Promise<string>} final status after attempt
 */
async function connect() {
  const { wsUrl, enabled } = await settings();
  const gen = ++connectGen;

  if (!enabled) {
    closeSocket();
    setStatus("OFF");
    return status;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    setStatus("LIVE", wsUrl);
    return status;
  }

  closeSocket();
  setStatus("CONNECTING", wsUrl);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (next, detail = "") => {
      if (gen !== connectGen || settled) return;
      settled = true;
      setStatus(next, detail);
      resolve(status);
    };

    let sock;
    try {
      sock = new WebSocket(wsUrl);
    } catch (err) {
      finish("ERR", String(err?.message || err));
      scheduleReconnect();
      return;
    }
    ws = sock;

    const timer = setTimeout(() => {
      if (gen !== connectGen) return;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      finish("ERR", "timeout — is the fight server running?");
      scheduleReconnect();
    }, 8000);

    sock.onopen = () => {
      clearTimeout(timer);
      finish("LIVE", wsUrl);
    };

    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "aggressionAlert" && msg.payload) {
        showAlert(msg.payload);
      }
    };

    sock.onerror = () => {
      // onclose will follow; keep detail for popup
      chrome.storage.local.set({
        connectionDetail: "WebSocket error — check URL / server / Allow local network",
      });
    };

    sock.onclose = () => {
      clearTimeout(timer);
      if (gen !== connectGen) return;
      if (ws === sock) ws = null;
      if (!settled) {
        finish("DOWN", "closed before open");
      } else if (status === "LIVE") {
        setStatus("DOWN", "disconnected");
      }
      if (enabled) scheduleReconnect();
    };
  });
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
  const id = String(alert.id || `${alert.symbol}-${side}-${Date.now()}`);

  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message: body,
      priority: 2,
    });
  } catch (err) {
    console.error("notification failed", err);
  }

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

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set(DEFAULTS);
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") connect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.wsUrl || changes.enabled || changes.uiUrl) {
    connect();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getStatus") {
    chrome.storage.local.get(["connectionStatus", "connectionDetail"]).then((s) => {
      sendResponse({
        status: s.connectionStatus || status,
        detail: s.connectionDetail || "",
      });
    });
    return true;
  }
  if (msg?.type === "reconnect") {
    connect()
      .then(async (finalStatus) => {
        const s = await chrome.storage.local.get(["connectionDetail"]);
        sendResponse({ status: finalStatus, detail: s.connectionDetail || "" });
      })
      .catch((err) => sendResponse({ status: "ERR", detail: String(err) }));
    return true;
  }
});

connect();
