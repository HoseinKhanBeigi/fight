/**
 * Persistent WebSocket host (offscreen document).
 * MV3 service workers sleep and drop sockets; this page stays alive.
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
    postStatus("OFF", "");
  }
});

function postStatus(status, detail = "") {
  chrome.runtime.sendMessage({
    source: "offscreen",
    type: "status",
    status,
    detail,
  }).catch(() => {});
}

function postAlert(payload) {
  chrome.runtime.sendMessage({
    source: "offscreen",
    type: "aggressionAlert",
    payload,
  }).catch(() => {});
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
    postStatus("OFF", "");
    return;
  }
  if (!wsUrl) {
    postStatus("ERR", "missing wsUrl");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    postStatus("LIVE", wsUrl);
    return;
  }

  closeSocket();
  postStatus("CONNECTING", wsUrl);

  let sock;
  try {
    sock = new WebSocket(wsUrl);
  } catch (err) {
    postStatus("ERR", String(err?.message || err));
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
    postStatus("ERR", "timeout — is fight server running?");
    scheduleReconnect(wsUrl, enabled);
  }, 8000);

  sock.onopen = () => {
    if (myGen !== gen) return;
    clearTimeout(timer);
    postStatus("LIVE", wsUrl);
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
      postAlert(msg.payload);
    }
  };

  sock.onerror = () => {
    postStatus("ERR", "WebSocket error — check Local network access");
  };

  sock.onclose = () => {
    clearTimeout(timer);
    if (myGen !== gen) return;
    if (ws === sock) ws = null;
    postStatus("DOWN", "disconnected");
    scheduleReconnect(wsUrl, enabled);
  };
}

// Ask service worker for current settings on boot
chrome.runtime.sendMessage({ source: "offscreen", type: "ready" }).catch(() => {});
