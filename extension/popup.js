const DEFAULT_SERVER = "http://31.130.204.146:8000";

const statusEl = document.getElementById("status");
const seedBtn = document.getElementById("seedBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const nmInput = document.getElementById("nmId");
const collectModeEl = document.getElementById("collectMode");
const serverInput = document.getElementById("serverInput");
const tokenInput = document.getElementById("tokenInput");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");

const searchStatusEl = document.getElementById("searchStatus");
const searchStartBtn = document.getElementById("searchStartBtn");
const searchStopBtn = document.getElementById("searchStopBtn");
const categorySelect = document.getElementById("categorySelect");
let categoryFilters = [];
let captchaNotice = "";

function captchaHtml() {
  return captchaNotice
    ? `<div style="margin-bottom:6px;padding:5px 7px;border-radius:6px;background:#fdecea;color:#b71c1c;font-weight:600;line-height:1.3">${captchaNotice}</div>`
    : "";
}

// === Коллектор текущей карточки (Ш8) ===
const autoCaptureEl = document.getElementById("autoCapture");
const capBtn = document.getElementById("capBtn");
const recapBtn = document.getElementById("recapBtn");
const capStatusEl = document.getElementById("capStatus");

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function tabMessage(msg) {
  const tab = await activeTab();
  if (!tab || !tab.id) return { error: "нет активной вкладки" };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, msg);
    return res || {};
  } catch {
    return { error: "откройте карточку WB и обновите страницу (F5) после обновления расширения" };
  }
}

async function refreshCapStatus() {
  if (!capStatusEl) return;
  let cnt = 0;
  try {
    const s = await chrome.storage.session.get({ capCount: 0 });
    cnt = s.capCount || 0;
  } catch {}
  const r = await tabMessage({ type: "WB_CAP_STATE" });
  let text;
  if (r.error) text = r.error;
  else if (!r.nm) text = "не карточка WB";
  else if (!r.state) text = `nm ${r.nm}: ещё не собрано`;
  else if (r.state.reason === "own_card") text = `nm ${r.nm}: ваша карточка (кнопкой — в обход)`;
  else if (r.state.reason === "fresh") text = `nm ${r.nm}: уже собрано`;
  else text = `nm ${r.nm}: сохранено (${r.state.desc || 0} симв., ${r.state.chars || 0} хар-к)`;
  if (cnt) text += ` · за сессию: ${cnt}`;
  capStatusEl.textContent = text;
}

async function capRun(force) {
  capBtn.disabled = true;
  recapBtn.disabled = true;
  capStatusEl.textContent = force ? "пересобираю… (10–30 с)" : "собираю… (10–30 с)";
  const r = await tabMessage({ type: "WB_RUN_CAPTURE", force });
  if (r.error) capStatusEl.textContent = r.error;
  capBtn.disabled = false;
  recapBtn.disabled = false;
  await refreshCapStatus();
}

if (capBtn) capBtn.onclick = () => capRun(false);
if (recapBtn) recapBtn.onclick = () => capRun(true);
if (autoCaptureEl) {
  chrome.storage.local.get({ autoCapture: true }, (s) => {
    autoCaptureEl.checked = !!s.autoCapture;
  });
  autoCaptureEl.onchange = () => {
    chrome.storage.local.set({ autoCapture: autoCaptureEl.checked });
  };
}


async function settings() {
  try {
    const s = await chrome.storage.local.get({ server: DEFAULT_SERVER, extToken: "", categoryId: "" });
    return { server: String(s.server || DEFAULT_SERVER).replace(/\/+$/, ""), token: s.extToken || "", categoryId: s.categoryId || "" };
  } catch {
    return { server: DEFAULT_SERVER, token: "", categoryId: "" };
  }
}

async function api(path, opts = {}) {
  const { server, token } = await settings();
  const headers = { ...(opts.headers || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  return fetch(server + path, { ...opts, headers });
}

async function loadSettingsIntoForm() {
  const s = await settings();
  if (serverInput) serverInput.value = s.server;
  if (tokenInput && !tokenInput.value) tokenInput.value = s.token;
  await loadFilters(s.categoryId);
}

// Пресеты фильтра категорий с сервера (xsubject). Нет связи/пусто — только «Без фильтра».
async function loadFilters(savedId) {
  categoryFilters = [];
  try {
    const r = await api("/api/ext/filters");
    if (r.ok) categoryFilters = await r.json();
  } catch {}
  while (categorySelect.options.length > 1) categorySelect.remove(1);
  for (const f of categoryFilters) {
    const o = document.createElement("option");
    o.value = String(f.id);
    o.textContent = `${f.name} (${f.subjects})`;
    categorySelect.appendChild(o);
  }
  if (savedId && [...categorySelect.options].some(o => o.value === String(savedId))) {
    categorySelect.value = String(savedId);
  }
}

if (categorySelect) {
  categorySelect.onchange = async () => {
    try { await chrome.storage.local.set({ categoryId: categorySelect.value || "" }); } catch {}
  };
}

if (saveSettingsBtn) {
  saveSettingsBtn.onclick = async () => {
    await chrome.storage.local.set({
      server: (serverInput.value || "").trim() || DEFAULT_SERVER,
      extToken: (tokenInput.value || "").trim(),
    });
    await refreshStatus();
    await refreshSearchStatus();
  };
}

function setProgress(id, done, total) {
  const el = document.getElementById(id);
  const pct = total ? Math.round((done / total) * 100) : 0;
  el.style.width = pct + "%";
}

async function refreshStatus() {
  try {
    const v = nmInput.value.trim();
    let url = `/api/ext/status`;
    if (v) url += `?nm_id=${v}`;
    const r = await api(url);
    if (r.status === 401 || r.status === 403) {
      statusEl.textContent = "Нет доступа: введите токен выше и нажмите ОК";
      return;
    }
    const d = await r.json();
    const mode = collectModeEl ? collectModeEl.value : "new";
    const pending = d.pending || 0;
    const need = d.need_update || 0;
    const processing = d.processing || 0;
    statusEl.innerHTML =
      captchaHtml() +
      `Всего: <b>${d.total}</b><br>` +
      `Новые: <span class="pending">${pending}</span><br>` +
      `Обновление: <span class="pending">${need}</span><br>` +
      `В работе: <span class="pending">${processing}</span><br>` +
      `Обработано: <span class="done">${d.done || 0}</span><br>` +
      `Ошибки: <span class="error">${d.error || 0}</span>`;
    startBtn.disabled = mode === "refresh"
      ? need === 0
      : mode === "all"
        ? (pending + need) === 0
        : pending === 0;
    const totalForMode = mode === "refresh"
      ? need + processing + (d.done || 0)
      : mode === "all"
        ? pending + need + processing + (d.done || 0)
        : pending + processing + (d.done || 0);
    setProgress("progressEnrich", d.done || 0, totalForMode);
  } catch {
    statusEl.textContent = "Сервер недоступен";
  }
}

async function refreshSearchStatus() {
  try {
    const source = document.getElementById("searchSource").value;
    const v = nmInput.value.trim();
    let url = `/api/ext/search_status?source=${source}`;
    if (v) url += `&nm_id=${v}`;
    const r = await api(url);
    if (r.status === 401 || r.status === 403) {
      searchStatusEl.textContent = "Нет доступа: введите токен выше и нажмите ОК";
      return;
    }
    const d = await r.json();
    searchStatusEl.innerHTML =
      captchaHtml() +
      `Всего: <b>${d.total}</b><br>` +
      `В очереди: <span class="pending">${d.pending || 0}</span><br>` +
      `В работе: <span class="pending">${d.processing || 0}</span><br>` +
      `Обработано: <span class="done">${d.done || 0}</span><br>` +
      `Ошибки: <span class="error">${d.error || 0}</span>`;
    searchStartBtn.disabled = d.pending === 0;
    setProgress("progressSearch", d.done || 0, d.total || 0);
  } catch {
    searchStatusEl.textContent = "Сервер недоступен";
  }
}

seedBtn.onclick = async () => {
  seedBtn.disabled = true;
  const body = {};
  const v = nmInput.value.trim();
  if (v) body.source_nm_id = parseInt(v);
  try {
    await api(`/api/ext/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await refreshStatus();
  } catch (e) {
    statusEl.textContent = "Ошибка: " + e.message;
  }
  seedBtn.disabled = false;
};

startBtn.onclick = () => {
  captchaNotice = "";
  startBtn.disabled = true;
  stopBtn.disabled = false;
  const v = nmInput.value.trim();
  chrome.runtime.sendMessage({
    type: "START",
    nm_id: v ? parseInt(v) : null,
    mode: collectModeEl ? collectModeEl.value : "new",
  });
};

stopBtn.onclick = () => {
  stopBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "STOP" });
};

searchStartBtn.onclick = () => {
  captchaNotice = "";
  searchStartBtn.disabled = true;
  searchStopBtn.disabled = false;
  const v = nmInput.value.trim();
  const source = document.getElementById("searchSource").value;
  const picked = categoryFilters.find(f => String(f.id) === categorySelect.value);
  chrome.runtime.sendMessage({ type: "SEARCH_START", nm_id: v ? parseInt(v) : null, filterSubjects: picked ? picked.subjects : null, source });
};

searchStopBtn.onclick = () => {
  searchStopBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "SEARCH_STOP" });
};

document.getElementById("resetEnrichBtn").onclick = async () => {
  const v = nmInput.value.trim();
  await api(`/api/ext/reset_enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(v ? { nm_id: parseInt(v) } : {}),
  });
  await refreshStatus();
};
document.getElementById("resetSearchBtn").onclick = async () => {
  const v = nmInput.value.trim();
  const source = document.getElementById("searchSource").value;
  await api(`/api/ext/reset_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nm_id: v ? parseInt(v) : null, source }),
  });
  await refreshSearchStatus();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "DONE") {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    refreshStatus();
  }
  if (msg.type === "SEARCH_DONE") {
    searchStartBtn.disabled = true;
    searchStopBtn.disabled = true;
    refreshSearchStatus();
    refreshStatus();
  }
  if (msg.type === "CAPTCHA") {
    captchaNotice = "WB показал капчу. Решите её в открытой вкладке и запустите снова.";
    stopBtn.disabled = true;
    searchStopBtn.disabled = true;
    refreshStatus();
    refreshSearchStatus();
  }
});

document.getElementById("searchSource").addEventListener("change", refreshSearchStatus);
nmInput.addEventListener("input", () => { refreshStatus(); refreshSearchStatus(); });

if (collectModeEl) {
  chrome.storage.local.get({ collectMode: "new" }, (s) => {
    collectModeEl.value = s.collectMode || "new";
    refreshStatus();
  });
  collectModeEl.addEventListener("change", () => {
    chrome.storage.local.set({ collectMode: collectModeEl.value || "new" });
    refreshStatus();
  });
}

// авто-обновление прогресса пока попап открыт + бейдж
setInterval(() => { refreshStatus(); refreshSearchStatus(); refreshCapStatus(); }, 2000);

chrome.action.getBadgeText({}).then((t) => {
  if (t === "CAP") {
    captchaNotice = "WB показал капчу. Решите её в открытой вкладке и запустите снова.";
    stopBtn.disabled = true;
    searchStopBtn.disabled = true;
    refreshStatus();
    refreshSearchStatus();
  }
}).catch(() => {});

loadSettingsIntoForm().then(() => { refreshStatus(); refreshSearchStatus(); refreshCapStatus(); });
