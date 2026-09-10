const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:8787/ws",
  uiUrl: "http://127.0.0.1:8787",
  enabled: true,
};

const statusEl = document.getElementById("status");
const enabledEl = document.getElementById("enabled");
const wsUrlEl = document.getElementById("wsUrl");
const uiUrlEl = document.getElementById("uiUrl");
const saveBtn = document.getElementById("save");

function paintStatus(s, detail = "") {
  const v = String(s || "…");
  statusEl.textContent = detail ? `Connection: ${v}\n${detail}` : `Connection: ${v}`;
  statusEl.className = "status " + v.toLowerCase();
}

async function load() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  enabledEl.checked = !!cfg.enabled;
  wsUrlEl.value = cfg.wsUrl;
  uiUrlEl.value = cfg.uiUrl;

  const local = await chrome.storage.local.get({
    connectionStatus: "…",
    connectionDetail: "",
  });
  paintStatus(local.connectionStatus, local.connectionDetail);

  chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
    if (chrome.runtime.lastError) {
      paintStatus("ERR", chrome.runtime.lastError.message);
      return;
    }
    if (res?.status) paintStatus(res.status, res.detail || "");
  });
}

saveBtn.addEventListener("click", async () => {
  paintStatus("CONNECTING", "saving…");
  await chrome.storage.local.set({
    enabled: enabledEl.checked,
    wsUrl: wsUrlEl.value.trim() || DEFAULTS.wsUrl,
    uiUrl: uiUrlEl.value.trim() || DEFAULTS.uiUrl,
  });
  chrome.runtime.sendMessage({ type: "reconnect" }, (res) => {
    if (chrome.runtime.lastError) {
      paintStatus("ERR", chrome.runtime.lastError.message);
      return;
    }
    paintStatus(res?.status || "ERR", res?.detail || "");
  });
});

load();
setInterval(() => {
  chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
    if (!chrome.runtime.lastError && res?.status) {
      paintStatus(res.status, res.detail || "");
    }
  });
}, 1500);
