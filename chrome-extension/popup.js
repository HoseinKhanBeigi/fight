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
    .slice(0, 15)
    .map((a) => {
      const t = a.ts ? new Date(a.ts).toLocaleTimeString() : "";
      return `<div>${t} · ${a.title || a.body || "alert"}</div>`;
    })
    .join("");
}

async function refreshFromStorage() {
  const s = await chrome.storage.local.get({
    ...DEFAULTS,
    connectionStatus: "…",
    connectionDetail: "",
    recentAlerts: [],
  });
  enabledEl.checked = !!s.enabled;
  if (document.activeElement !== wsUrlEl) wsUrlEl.value = s.wsUrl || DEFAULTS.wsUrl;
  if (document.activeElement !== uiUrlEl) uiUrlEl.value = s.uiUrl || DEFAULTS.uiUrl;
  paintStatus(s.connectionStatus, s.connectionDetail || "");
  paintRecent(s.recentAlerts || []);
}

saveBtn.addEventListener("click", async () => {
  paintStatus("CONNECTING", "saving…");
  await chrome.storage.local.set({
    enabled: enabledEl.checked,
    wsUrl: wsUrlEl.value.trim() || DEFAULTS.wsUrl,
    uiUrl: uiUrlEl.value.trim() || DEFAULTS.uiUrl,
  });
  chrome.runtime.sendMessage({ type: "reconnect" }, async () => {
    await refreshFromStorage();
  });
});

testBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "testNotify" }, async () => {
    await refreshFromStorage();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.recentAlerts || changes.connectionStatus || changes.connectionDetail) {
    refreshFromStorage();
  }
});

refreshFromStorage();
setInterval(refreshFromStorage, 1000);
