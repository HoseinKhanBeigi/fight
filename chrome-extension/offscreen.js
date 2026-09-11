/**
 * Persistent WebSocket only.
 * Does NOT touch chrome.storage (can be undefined in some offscreen/timing cases).
 * Alerts are queued and delivered to the service worker with retries.
 */

let ws = null;
let reconnectTimer = null;
let gen = 0;
let wsUrlCurrent = "";
let enabledCurrent = true;
const alertQueue = [];
let flushTimer = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "connect") {
    connect(msg.wsUrl, msg.enabled !== false);
    sendResponse?.({ ok: true });
    return true;
  }
  if (msg.type === "disconnect") {
    gen += 1;
    closeSocket();
    postStatus("OFF", "");
    sendResponse?.({ ok: true });
    return true;
  }
  if (msg.type === "ping") {
    sendResponse?.({
      ok: true,
      ws: ws?.readyState ?? -1,
      queue: alertQueue.length,
    });
    return true;
  }
});

function postStatus(status, detail = "") {
  safeSend({ source: "offscreen", type: "status", status, detail });
}

function safeSend(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true, res });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function enqueueAlert(payload) {
  alertQueue.push(payload);
  if (alertQueue.length > 100) alertQueue.splice(0, alertQueue.length - 100);
  flushQueue();
}

async function flushQueue() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    while (alertQueue.length) {
      const payload = alertQueue[0];
      const result = await safeSend({
        source: "offscreen",
        type: "aggressionAlert",
        payload,
      });
      if (!result.ok) {
        // SW still waking — retry soon
        setTimeout(flushQueue, 250);
        return;
      }
      alertQueue.shift();
    }
  }, 0);
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

function scheduleReconnect(ms = 2500) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(wsUrlCurrent, enabledCurrent), ms);
}

function connect(wsUrl, enabled) {
  const myGen = ++gen;
  wsUrlCurrent = wsUrl || wsUrlCurrent;
  enabledCurrent = enabled;

  if (!enabled) {
    closeSocket();
    postStatus("OFF", "");
    return;
  }
  if (!wsUrlCurrent) {
    postStatus("ERR", "missing wsUrl");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    postStatus("LIVE", wsUrlCurrent);
    flushQueue();
    return;
  }

  closeSocket();
  postStatus("CONNECTING", wsUrlCurrent);

  let sock;
  try {
    sock = new WebSocket(wsUrlCurrent);
  } catch (err) {
    postStatus("ERR", String(err?.message || err));
    scheduleReconnect();
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
    postStatus("ERR", "timeout — is fight server running?");
    scheduleReconnect();
  }, 8000);

  sock.onopen = () => {
    if (myGen !== gen) return;
    clearTimeout(timer);
    postStatus("LIVE", wsUrlCurrent);
    flushQueue();
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
      enqueueAlert(msg.payload);
    }
    // smartAlert intentionally ignored — desktop push is raw aggression only
  };

  sock.onerror = () => {
    postStatus("ERR", "WebSocket error — check Local network access");
  };

  sock.onclose = () => {
    clearTimeout(timer);
    if (myGen !== gen) return;
    if (ws === sock) ws = null;
    postStatus("DOWN", "disconnected");
    scheduleReconnect();
  };
}

safeSend({ source: "offscreen", type: "ready" });
setInterval(() => {
  if (alertQueue.length) flushQueue();
  if (ws && ws.readyState === WebSocket.OPEN) {
    postStatus("LIVE", wsUrlCurrent);
  }
}, 5000);
