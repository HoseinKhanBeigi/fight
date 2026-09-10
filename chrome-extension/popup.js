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
const testBtn = document.getElementById("test");
const recentEl = document.getElementById("recent");

function paintStatus(s, detail = "") {
  const v = String(s || "…");
  statusEl.textContent = detail ? `Connection: ${v}\n${detail}` : `Connection: ${v}`;
  statusEl.className = "status " + v.toLowerCase();
}

function paintRecent(list) {
  if (!list?.length) {
    recentEl.textContent = "None yet";
    return;
  }
  recentEl.innerHTML = list
    .slice(0, 6)
    .map((a) => {
      const t = a.ts ? new Date(a.ts).toLocaleTimeString() : "";
      return `<div>${t} · ${a.title || a.body || "alert"}</div>`;
    })
    .join("");
}

async function load() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  enabledEl.checked = !!cfg.enabled;
  wsUrlEl.value = cfg.wsUrl;
  uiUrlEl.value = cfg.uiUrl;

  chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
    if (chrome.runtime.lastError) {
      paintStatus("ERR", chrome.runtime.lastError.message);
      return;
    }
    paintStatus(res?.status || "…", res?.detail || "");
    paintRecent(res?.recentAlerts || []);
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

testBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "testNotify" }, () => {
    if (chrome.runtime.lastError) {
      paintStatus("ERR", chrome.runtime.lastError.message);
    }
  });
});

load();
setInterval(load, 2000);
