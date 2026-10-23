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

// ── Шапка / настройки / онбординг ──
const onboardView = document.getElementById("onboardView");
const onboardInput = document.getElementById("onboardInput");
const onboardSaveBtn = document.getElementById("onboardSaveBtn");
const mainView = document.getElementById("mainView");
const connEl = document.getElementById("connEl");
const connText = document.getElementById("connText");
const gearBtn = document.getElementById("gearBtn");
const settingsBox = document.getElementById("settingsBox");

// ── Глобальная строка «что сейчас работает» ──
const globalRunEl = document.getElementById("globalRun");
const globalWhatEl = document.getElementById("globalWhat");
const globalEtaEl = document.getElementById("globalEta");
const globalStopBtn = document.getElementById("globalStopBtn");
const colCap = document.getElementById("colCap");
const colSearch = document.getElementById("colSearch");

function captchaHtml() {
  return captchaNotice
    ? `<div class="captcha">${captchaNotice}</div>`
    : "";
}

// ── Онбординг: пока нет токена — показываем только его ввод ──
function showOnboard(on) {
  onboardView.style.display = on ? "block" : "none";
  mainView.style.display = on ? "none" : "block";
}

onboardSaveBtn.onclick = async () => {
  const t = (onboardInput.value || "").trim();
  if (!t) return; // пустой токен не сохраняем — онбординг остаётся
  await chrome.storage.local.set({ extToken: t });
  showOnboard(false);
  await loadSettingsIntoForm();
  await refreshAll();
};

gearBtn.onclick = () => settingsBox.classList.toggle("show");

// Клик по индикатору подключения тоже открывает настройки
connEl.onclick = () => settingsBox.classList.toggle("show");

function setConn(ok, text) {
  connEl.classList.toggle("bad", !ok);
  connText.textContent = text || (ok ? "Подключено" : "Нет связи");
}

// ── Коллектор текущей карточки (Ш8) ──
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
  else if (!r.nm) text = "Это не страница карточки";
  else if (!r.state) text = `nm ${r.nm}: ещё не собрано`;
  else if (r.state.reason === "own_card") text = `nm ${r.nm}: ваша карточка — соберите вручную кнопкой`;
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

capBtn.onclick = () => capRun(false);
recapBtn.onclick = () => capRun(true);
chrome.storage.local.get({ autoCapture: true }, (s) => {
  autoCaptureEl.checked = !!s.autoCapture;
});
autoCaptureEl.onchange = () => {
  chrome.storage.local.set({ autoCapture: autoCaptureEl.checked });
};


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

categorySelect.onchange = async () => {
  try { await chrome.storage.local.set({ categoryId: categorySelect.value || "" }); } catch {}
};

saveSettingsBtn.onclick = async () => {
  await chrome.storage.local.set({
    server: (serverInput.value || "").trim() || DEFAULT_SERVER,
    extToken: (tokenInput.value || "").trim(),
  });
  await refreshStatus();
  await refreshSearchStatus();
};

function setProgress(id, done, total) {
  const el = document.getElementById(id);
  const pct = total ? Math.round((done / total) * 100) : 0;
  el.style.width = pct + "%";
}

function statusRows(el, rows) {
  el.innerHTML =
    captchaHtml() +
    rows.map(([label, val, cls]) =>
      `<div class="k">${label} <b class="${cls}">${val}</b></div>`
    ).join("");
}

async function refreshStatus() {
  try {
    const v = nmInput.value.trim();
    let url = `/api/ext/status`;
    if (v) url += `?nm_id=${v}`;
    const r = await api(url);
    if (r.status === 401 || r.status === 403) {
      statusEl.innerHTML = "Нет доступа: проверьте токен в ⚙";
      return;
    }
    const d = await r.json();
    const mode = collectModeEl ? collectModeEl.value : "new";
    const pending = d.pending || 0;
    const need = d.need_update || 0;
    const processing = d.processing || 0;
    statusRows(statusEl, [
      ["Всего", d.total],
      ["Новые", pending, "pending"],
      ["Обновление", need, "pending"],
      ["В работе", processing, "pending"],
      ["Обработано", d.done || 0, "done"],
      ["Ошибки", d.error || 0, "error"],
    ]);
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
    setConn(true);
  } catch {
    statusEl.textContent = "Сервер недоступен";
    setConn(false);
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
      searchStatusEl.innerHTML = "Нет доступа: проверьте токен в ⚙";
      return;
    }
    const d = await r.json();
    statusRows(searchStatusEl, [
      ["Всего", d.total],
      ["В очереди", d.pending || 0, "pending"],
      ["В работе", d.processing || 0, "pending"],
      ["Обработано", d.done || 0, "done"],
      ["Ошибки", d.error || 0, "error"],
    ]);
    searchStartBtn.disabled = d.pending === 0;
    setProgress("progressSearch", d.done || 0, d.total || 0);
    setConn(true);
  } catch {
    searchStatusEl.textContent = "Сервер недоступен";
    setConn(false);
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
  // Одновременно работает один режим: поиск глушит background, тут приводим
  // его кнопки в исходное состояние.
  searchStopBtn.disabled = true;
  searchStartBtn.disabled = false;
  const v = nmInput.value.trim();
  chrome.runtime.sendMessage({
    type: "START",
    nm_id: v ? parseInt(v) : null,
    mode: collectModeEl ? collectModeEl.value : "new",
  });
};

let stopAll = () => {};

stopBtn.onclick = () => {
  stopBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "STOP" });
};

searchStartBtn.onclick = () => {
  captchaNotice = "";
  searchStartBtn.disabled = true;
  searchStopBtn.disabled = false;
  // Одновременно работает один режим: очередь карточек глушит background.
  stopBtn.disabled = true;
  startBtn.disabled = false;
  const v = nmInput.value.trim();
  const source = document.getElementById("searchSource").value;
  const picked = categoryFilters.find(f => String(f.id) === categorySelect.value);
  chrome.runtime.sendMessage({ type: "SEARCH_START", nm_id: v ? parseInt(v) : null, filterSubjects: picked ? picked.subjects : null, source });
};

searchStopBtn.onclick = () => {
  searchStopBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "SEARCH_STOP" });
};

// «Стоп всё» — глушим оба потока сразу
stopAll = () => {
  chrome.runtime.sendMessage({ type: "STOP" });
  chrome.runtime.sendMessage({ type: "SEARCH_STOP" });
  stopBtn.disabled = true;
  searchStopBtn.disabled = true;
};
globalStopBtn.onclick = stopAll;

// === ПРОГРЕСС СБОРА ===
// Читаем из storage.session (background туда пишет): обработано X из Y,
// что собираем сейчас и сколько примерно осталось.
// Версия расширения — рядом с заголовком (в шапке)
try {
  const verEl = document.getElementById("verTag");
  if (verEl) verEl.textContent = "v" + chrome.runtime.getManifest().version;
} catch {}

// Имя токена: спрашиваем сервер, кто мы (ext_tokens.name)
async function refreshTokenName() {
  const a = document.getElementById("tokenName");
  const b = document.getElementById("tokenName2");
  const set = (v) => { if (a) a.textContent = v; if (b) b.textContent = v; };
  try {
    const r = await api("/api/ext/whoami");
    if (r.status !== 200) { set("—"); return; }
    const d = await r.json();
    set(d && d.name ? d.name : "без имени");
  } catch {
    set("—");
  }
}

// «глазик»: показать / скрыть сам токен
function bindTokenEye() {
  const btn = document.getElementById("tokenEyeBtn");
  const inp = document.getElementById("tokenInput");
  if (!btn || !inp || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => {
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "🙈" : "👁";
    btn.title = show ? "Скрыть токен" : "Показать токен";
    try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
  });
}

const PROGRESS_KEY = "collectProgress";
const enrichProgressEl = document.getElementById("enrichProgress");
const searchProgressEl = document.getElementById("searchProgress");

function etaText(prog) {
  if (!prog || !prog.total || !prog.done || !prog.startedAt) return "";
  const per = (Date.now() - prog.startedAt) / prog.done;
  const left = Math.max(0, (prog.total - prog.done) * per);
  const min = Math.round(left / 60000);
  if (min < 1) return "осталось меньше минуты";
  if (min < 60) return `осталось ~${min} мин`;
  return `осталось ~${Math.round(min / 60)} ч`;
}

function progressLine(prog, mode) {
  if (!prog || prog.mode !== mode) return "";
  if (prog.finished) return `Готово: обработано ${prog.done || 0} из ${prog.total || 0}`;
  const parts = [];
  if (prog.total) parts.push(`обработано ${prog.done || 0} из ${prog.total}`);
  if (prog.current) parts.push(`сейчас: ${prog.current}`);
  const eta = etaText(prog);
  if (eta) parts.push(eta);
  return parts.join(" · ");
}

async function renderProgress() {
  let prog = {};
  try {
    prog = (await chrome.storage.session.get({ [PROGRESS_KEY]: {} }))[PROGRESS_KEY] || {};
  } catch {}
  const e = progressLine(prog, "enrich");
  const s = progressLine(prog, "search");
  if (enrichProgressEl) enrichProgressEl.textContent = e;
  if (searchProgressEl) searchProgressEl.textContent = s;

  // глобальная строка + подсветка работающей колонки
  const running = !prog.finished && (prog.mode === "enrich" || prog.mode === "search");
  globalRunEl.classList.toggle("on", running);
  if (running) {
    globalWhatEl.textContent = prog.mode === "enrich" ? "Работает: сбор карточек" : "Работает: поиск";
    globalEtaEl.textContent = progressLine(prog, prog.mode);
  }
  colCap.classList.toggle("working", running && prog.mode === "enrich");
  colSearch.classList.toggle("working", running && prog.mode === "search");
}

// прогресс обновляем, пока попап открыт
setInterval(renderProgress, 2000);
renderProgress();
bindTokenEye();
refreshTokenName();
setInterval(refreshTokenName, 15000);

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

function refreshAll() {
  return Promise.all([refreshStatus(), refreshSearchStatus(), refreshCapStatus()]);
}

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
    // Останавливаются кнопки только потока, который капча реально погасила
    // (background присылает stopped per-flow).
    const stopped = (msg.data && msg.data.stopped) || {};
    if (stopped.enrich !== false) stopBtn.disabled = true;
    if (stopped.search !== false) searchStopBtn.disabled = true;
    refreshStatus();
    refreshSearchStatus();
  }
});

document.getElementById("searchSource").addEventListener("change", refreshSearchStatus);
nmInput.addEventListener("input", () => { refreshStatus(); refreshSearchStatus(); });

chrome.storage.local.get({ collectMode: "new" }, (s) => {
  collectModeEl.value = s.collectMode || "new";
  refreshStatus();
});
collectModeEl.addEventListener("change", () => {
  chrome.storage.local.set({ collectMode: collectModeEl.value || "new" });
  refreshStatus();
});

// Плашка «обновите расширение»: сервер сообщил, что его контракт новее нашего.
const updateBanner = document.getElementById("updateBanner");
function refreshUpdateBanner() {
  if (!updateBanner) return;
  chrome.storage.local.get({ extUpdate: null, extToken: "" }, (s) => {
    const u = s && s.extUpdate;
    if (u && u.needed && s.extToken) {
      updateBanner.style.display = "block";
      updateBanner.title = `сервер ждёт контракт ${u.server}, у нас ${u.mine}`;
    } else {
      updateBanner.style.display = "none";
    }
  });
}

// авто-обновление: статусы, сбор, онбординг
setInterval(async () => {
  const s = await chrome.storage.local.get({ extToken: "" });
  showOnboard(!s.extToken);
  if (!s.extToken) return;
  refreshStatus();
  refreshSearchStatus();
  refreshCapStatus();
}, 2000);

chrome.action.getBadgeText({}).then((t) => {
  if (t === "CAP") {
    captchaNotice = "WB показал капчу. Решите её в открытой вкладке и запустите снова.";
    stopBtn.disabled = true;
    searchStopBtn.disabled = true;
    refreshStatus();
    refreshSearchStatus();
  }
}).catch(() => {});

async function init() {
  const s = await chrome.storage.local.get({ extToken: "" });
  showOnboard(!s.extToken);
  if (s.extToken) {
    await loadSettingsIntoForm();
    await refreshAll();
  }
  refreshUpdateBanner();
}
init();
