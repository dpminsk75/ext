const DEFAULT_SERVER = "https://www.selbi.top";
const DEBUG = false;

// Паузы между карточками/запросами. WB быстро отдаёт капчу, если долбить его
// подряд: 32 карточки по 0.5 с — гарантированный WBAAS-бан. Рандом сбивает
// ровный ритм и выглядит как живой пользователь.
// Значения задаются в popup (⚙, секунды), ключи gapSearchMin/Max и
// gapEnrichMin/Max в storage.local. Меняются на лету, задний цикл не надо
// перезапускать — на следующем шаге возьмётся уже новый интервал.
const GAP_DEFAULTS = { gapSearchMin: 9, gapSearchMax: 16, gapEnrichMin: 5, gapEnrichMax: 10 };
let gaps = { ...GAP_DEFAULTS };

// Число ≥ 1, плохое значение → дефолт. Пользователь может задать большие паузы,
// но не нулевые — иначе снова долбит и банит.
function gapVal(v, dflt) {
  const n = Math.round(Number(v));
  return isFinite(n) && n >= 1 ? n : dflt;
}
function loadGaps() {
  chrome.storage.local.get(GAP_DEFAULTS).then((s) => {
    gaps = {
      gapSearchMin: gapVal(s.gapSearchMin, GAP_DEFAULTS.gapSearchMin),
      gapEnrichMin: gapVal(s.gapEnrichMin, GAP_DEFAULTS.gapEnrichMin),
    };
    gaps.gapSearchMax = Math.max(gaps.gapSearchMin, gapVal(s.gapSearchMax, GAP_DEFAULTS.gapSearchMax));
    gaps.gapEnrichMax = Math.max(gaps.gapEnrichMin, gapVal(s.gapEnrichMax, GAP_DEFAULTS.gapEnrichMax));
  }).catch(() => {});
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.gapSearchMin || ch.gapSearchMax || ch.gapEnrichMin || ch.gapEnrichMax) loadGaps();
});
loadGaps();

function rnd(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function searchGap() {
  return rnd(gaps.gapSearchMin * 1000, gaps.gapSearchMax * 1000);
}
function enrichGap() {
  return rnd(gaps.gapEnrichMin * 1000, gaps.gapEnrichMax * 1000);
}

// Настройки (SERVER + Bearer ext-токена) лежат в chrome.storage.local —
// их задают в popup (вкладка скачанного zip уже с правильным SERVER).
async function cfg() {
  try {
    const s = await chrome.storage.local.get({ server: DEFAULT_SERVER, extToken: "" });
    return { server: String(s.server || DEFAULT_SERVER).replace(/\/+$/, ""), token: s.extToken || "" };
  } catch {
    return { server: DEFAULT_SERVER, token: "" };
  }
}

// Версия протокола /api/ext (контракт). Bumpается ТОЛЬКО при несовместимом
// изменении формата/смысла существующих эндпоинтов (план 2026-10-22).
// Версия расширения (manifest) — косметика, по ней не сверяем.
const EXT_CONTRACT = 2;

async function api(path, opts = {}) {
  const { server, token } = await cfg();
  const headers = { ...(opts.headers || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  headers["X-Ext-Contract"] = String(EXT_CONTRACT);
  try {
    headers["X-Ext-Version"] = chrome.runtime.getManifest().version;
  } catch {}
  const res = await fetch(server + path, { ...opts, headers });
  checkContract(res);
  return res;
}

// Сервер сообщает свой контракт. Если он требует больше, чем умеет расширение —
// ругаемся в консоли и поднимаем плашку в popup («обновите расширение»).
let contractWarned = 0;
function checkContract(res) {
  try {
    const srv = Number(res.headers.get("X-Ext-Contract") || 0) || 0;
    const upd = res.headers.get("X-Ext-Update");
    if (!srv && !upd) return;
    if (!upd && srv <= EXT_CONTRACT) {
      chrome.storage.local.get("extUpdate").then((s) => {
        if (s && s.extUpdate) chrome.storage.local.remove("extUpdate");
      }).catch(() => {});
      return;
    }
    chrome.storage.local.set({
      extUpdate: { needed: true, server: srv, mine: EXT_CONTRACT, at: new Date().toISOString() },
    }).catch(() => {});
    if (contractWarned < 20) {
      contractWarned++;
      console.warn(
        `[EXT] ⚠ сервер ждёт контракт ${srv || "?"}, у нас ${EXT_CONTRACT} — ` +
          `обновите расширение (https://www.selbi.top/ext/install)`
      );
    }
  } catch {}
}

let running = false;
let enrichNmId = null;
let collectMode = "new";
let currentEnrichNm = null;
let searching = false;
let searchNmId = null;
let searchFilterSubjects = null;
let searchSource = "seo";
let searchQueue = null;
let searchSources = new Set();
let searchWatchdog = null;

// Вкладки, которые открыли МЫ САМИ (очередь/поиск). Только их и закрываем:
// раньше после /result закрывалась любая вкладка, включая ту, где пользователь работал.
// Тип вкладки ("enrich" — очередь карточек, "search" — поиск): результат принимаем
// только из вкладки своего типа, чтобы сбор карточек не записывался как выдача
// и наоборот (content_search.js инжектится на все страницы WB).
const ownTabs = new Map(); // tabId -> "enrich" | "search"
// Все вкладки, которые мы когда-либо открывали: позднее сообщение из них
// (рестарт SW, смена режима, тайм-аут) не должно превратиться в «ручной поиск».
const everOwnTabs = new Set();
// Вкладки расширения, выдача по которым уже принята (content_search может
// досылать обновление при догрузке — второй раз это не пишем).
// Записи не чистим по закрытию вкладки: позднее сообщение от уже закрытой вкладки
// не должно превратиться в «ручной поиск».
const handledTabs = new Set();

// === Скролл-досбор картинок выдачи ===
// WB рисует миниатюры лениво (top видимой области) и догружает пагинацию только
// при прокрутке. После первого посыла вкладку поиска НЕ закрываем сразу:
// командуем контенту доскроллить до ТОП-40 и ждём второй WB_SEARCH_RESULT
// (апдейт) или таймаут — потом закрываем вкладку и берём следующую фразу.
const SEARCH_SCROLL_WAIT_MS = 12000;
let searchAwaitTabs = new Set();   // tabId — ждём апдейт с картинками
const searchScrollTimers = new Map(); // tabId -> таймер завершения
const searchUpdateCtx = new Map(); // tabId -> {queue_id, nm_id, phrase, source, stamp}

function dropAwaitTab(id) {
  const t = searchScrollTimers.get(id);
  if (t) { clearTimeout(t); searchScrollTimers.delete(id); }
  searchAwaitTabs.delete(id);
  searchUpdateCtx.delete(id);
}

const SEARCH_SCROLL_CMD_MS = SEARCH_SCROLL_WAIT_MS - 2000;

async function armScrollUpdate(tId, ctx) {
  searchAwaitTabs.add(tId);
  searchUpdateCtx.set(tId, ctx || {});
  searchScrollTimers.set(tId, setTimeout(() => void finishSearchUpdate(tId), SEARCH_SCROLL_WAIT_MS));
  try {
    await chrome.tabs.sendMessage(tId, { type: "WB_SEARCH_SCROLL", maxMs: SEARCH_SCROLL_CMD_MS });
  } catch (e) {
    console.log("[SEARCH] команда скролл-досбора не доставлена:", String(e));
  }
  try { await saveLoopState(); } catch {}
}

// Апдейт доехал или окно кончилось: закрываем вкладку и берём следующую фразу
async function finishSearchUpdate(tId) {
  const t = searchScrollTimers.get(tId);
  if (t) { clearTimeout(t); searchScrollTimers.delete(tId); }
  if (!searchAwaitTabs.has(tId)) return;
  searchAwaitTabs.delete(tId);
  searchUpdateCtx.delete(tId);
  if (!DEBUG) {
    try { await chrome.tabs.remove(tId); } catch {}
  }
  ownTabs.delete(tId);
  everOwnTabs.delete(tId);
  await saveLoopState();
  if (searching && !DEBUG) setTimeout(searchNext, searchGap());
}

try {
  chrome.tabs.onRemoved.addListener((id) => {
    ownTabs.delete(id);
    dropAwaitTab(id);
  });
} catch {}

// === состояние циклов: переживает рестарт service worker (storage.session) ===
// MV3 убивает воркер по простою: без этого результаты из живых вкладок
// уходят мимо очереди (в «наблюдение»), а оборванные циклы молчат.
let loopReady = Promise.resolve();

async function saveLoopState() {
  try {
    // Флаги циклов не храним: после рестарта SW поток живёт только до
    // завершения текущего шага (результат летящей вкладки примем, новых
    // вкладок не откроем).
    await chrome.storage.session.set({
      loopState: {
        searchQueue,
        ownTabs: [...ownTabs], handled: [...handledTabs],
        awaitTabs: [...searchAwaitTabs], updateCtx: [...searchUpdateCtx],
      },
    });
  } catch {}
}

async function restoreLoopState() {
  // Персистентность нужна ТОЛЬКО для маршрутизации: типы своих вкладок,
  // принятые вкладки и элемент очереди «в полёте». Флаги running/searching
  // НЕ восстанавливаем и циклы сами не оживляем — иначе после обновления
  // расширения (вкладки остаются открытыми) цикл «воскресал» и начинал
  // открывать вкладки без ведома пользователя. Цикл стартует только кнопкой.
  try {
    const s = await chrome.storage.session.get({ loopState: null });
    const st = s && s.loopState;
    if (st) {
      for (const [id, kind] of st.ownTabs || []) {
        ownTabs.set(id, kind);
        everOwnTabs.add(id);
      }
      for (const id of st.handled || []) handledTabs.add(id);
      if (st.searchQueue) searchQueue = st.searchQueue;
      // Вкладки могли закрыть руками, пока воркер был неактивен.
      for (const id of [...ownTabs.keys()]) {
        try { await chrome.tabs.get(id); } catch { ownTabs.delete(id); }
      }
      // Элемент очереди без живой вкладки выдачи долететь не может — вернём в pending.
      if (searchQueue) {
        if ([...ownTabs.values()].includes("search")) armSearchWatchdog();
        else await reportSearchError();
      }
      // Ждали апдейт картинок, а SW перезапустился: вкладки живы — окно ожидания
      // заново и повторная команда скролла (прошлая могла потеряться).
      for (const [id, ctx] of st.updateCtx || []) {
        if (!ownTabs.has(id)) continue;
        searchAwaitTabs.add(id);
        searchUpdateCtx.set(id, ctx);
        searchScrollTimers.set(id, setTimeout(() => void finishSearchUpdate(id), SEARCH_SCROLL_WAIT_MS));
        try {
          await chrome.tabs.sendMessage(id, { type: "WB_SEARCH_SCROLL", maxMs: SEARCH_SCROLL_CMD_MS });
        } catch {}
      }
      for (const id of st.awaitTabs || []) searchAwaitTabs.add(id);
    }
  } catch {}
  try {
    console.log(
      `[EXT] background v${chrome.runtime.getManifest().version} старт, state:`,
      {
        running, searching,
        queue: searchQueue ? searchQueue.phrase : null,
        tabs: [...ownTabs].map(([id, k]) => `${id}:${k}`),
      }
    );
  } catch {}
}
loopReady = restoreLoopState();

// Закрываем только вкладки заданного потока: чужие (и капчу-вкладку) не трогаем.
async function closeOwnTabs(kind) {
  const ids = [...ownTabs].filter(([, k]) => k === kind).map(([id]) => id);
  for (const id of ids) {
    ownTabs.delete(id);
    try { await chrome.tabs.remove(id); } catch {}
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "WB_STOP_RUN") {
    // Стоп из плашки прогресса (вкладка-источник): останавливаем тот поток,
    // который сейчас идёт. Текущий элемент вернётся в очередь (pending) —
    // его можно перезапустить позже.
    getProgress().then(async (prog) => {
      try {
        if (prog.mode === "search") await stopSearchLoop();
        else await stopCollectLoop();
      } catch {}
      const done = prog.done || 0;
      const total = prog.baseTotal || 0;
      await setProgress({ finished: true, stopped: true, current: "", done, total });
      setProgressBadge(done, total, total > 0);
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "WB_PROGRESS_STATE") {
    // Вкладка спрашивает: «я — та, из которой запустили?» и какой прогресс.
    const tabId = sender && sender.tab && sender.tab.id;
    getProgress().then((prog) => {
      sendResponse({
        isSource: !!(prog.sourceTabId && tabId && tabId === prog.sourceTabId),
        prog,
      });
    });
    return true;
  }
  if (msg.type === "WB_MODE") {
    // Полный цикл — только для вкладок очереди карточек (enrich). Остальные свои
    // вкладки (поиск, капчу-вкладка после решения) — пассивный фон: пусть WB
    // перейдёт на карточку, полный сбор (скролл/клик) в них не уместен.
    const id = sender && sender.tab && sender.tab.id;
    loopReady.then(() => {
      sendResponse({ mode: ownTabs.get(id) === "enrich" ? "full" : "passive" });
    });
    return true;
  }
  if (msg.type === "WB_OBSERVE_CARD") {
    observeCard(msg.data);
  }
  if (msg.type === "WB_RESULT") {
    handleResult(msg.data, sender.tab?.id)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "WB_ENRICH_ERROR") {
    // Сбор карточки не удался (пустая страница/ошибка парса) — репортим,
    // иначе строка очереди висит в processing до 30-минутного серверного таймаута.
    console.warn(
      "[ENRICH] ошибка сбора:",
      (msg.data && (msg.data.nm_id + ": " + msg.data.error)) || msg.data
    );
    api("/api/ext/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.data || {}),
    }).catch((e) => console.error("[ENRICH] отчёт об ошибке не отправлен:", e));
    // Вкладку с неудачной карточкой закрываем: пока она открыта, processNext()
    // считает, что мы «ждём результат», и не берёт следующую карточку — цикл
    // вставал на несуществующих/битых карточках.
    const badTab = sender && sender.tab && sender.tab.id;
    if (badTab) {
      ownTabs.delete(badTab);
      everOwnTabs.delete(badTab);
      try { chrome.tabs.remove(badTab); } catch {}
    }
    if (currentEnrichNm && Number(msg.data && msg.data.nm_id) === currentEnrichNm) {
      currentEnrichNm = null;
    }
    bumpRunDone();
    if (enrichWatchdog) { clearTimeout(enrichWatchdog); enrichWatchdog = null; }
    if (running && !DEBUG) setTimeout(processNext, enrichGap());
    try { sendResponse({ ok: true }); } catch {}
  }
  if (msg.type === "CAPTURE") {
    doCapture(msg)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "CAP_STATE") {
    capState(msg.nm_id)
      .then((res) => sendResponse(res || null))
      .catch(() => sendResponse(null));
    return true;
  }
  if (msg.type === "WB_SEARCH_RESULT") {
    handleSearchResult(msg.data, sender.tab?.id)
      .then((res) => sendResponse(res || { ok: false, error: "no result" }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "WB_SHELVES") {
    sendShelves(msg.data)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, status: 0, error: String(e) }));
    return true;
  }
  if (msg.type === "WB_SHELF_RAW") {
    // Сырой ответ полки карточки (u-recom) — на сервер отдельным запросом:
    // сервер сохранит файл (нужен, чтобы переразобрать блок позже).
    sendShelfRaw(msg.data)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "WB_SEARCH_RAW") {
    // Своя search-вкладка фонового потока: помечаем сырые ответы карточкой
    // очереди (source_nm_id), чтобы сервер свёл JSON-запись выдачи в ТЕ ЖЕ
    // строки, что и DOM-запись /search_result (единый список источников).
    // Ручной поиск человека не метим — там привязка "наши карточки в выдаче".
    const rawTab = sender && sender.tab && sender.tab.id;
    let rawQueueNm = 0;
    if (rawTab && ownTabs.get(rawTab) === "search") {
      if (searchQueue && normPhrase(searchQueue.phrase || "") === normPhrase(msg.data && msg.data.phrase)) {
        rawQueueNm = searchQueue.nm_id || 0;
      } else {
        const rawCtx = searchUpdateCtx.get(rawTab);
        if (rawCtx) rawQueueNm = rawCtx.nm_id || 0;
      }
    }
    sendSearchRaw(rawQueueNm ? { ...msg.data, source_nm_id: rawQueueNm } : msg.data)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, status: 0, error: String(e) }));
    return true;
  }
  if (msg.type === "CAPTCHA") {
    handleCaptcha(msg.data, sender.tab?.id);
  }
  if (msg.type === "WB_DIAG") {
    api("/api/ext/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.data),
    }).catch(e => console.error("[ENRICH] diag save failed:", e));
  }
  if (msg.type === "START") {
    startCollectLoop(msg);
  }
  if (msg.type === "STOP") {
    stopCollectLoop();
  }
  if (msg.type === "SEARCH_START") {
    startSearchLoop(msg);
  }
  if (msg.type === "SEARCH_STOP") {
    stopSearchLoop();
  }
});

// === ЗАПУСК/ОСТАНОВКА ЦИКЛОВ ===
// Режимы взаимоисключающие: старт одного чисто останавливает второй, иначе два
// потока бегут параллельно — скачут вкладки, WB рано показывает капчу, а
// обработчики с общими state (ownTabs/searchQueue) путаются между потоками.

const normPhrase = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

async function startCollectLoop(msg) {
  await loopReady;
  await stopSearchLoop();
  running = true;
  enrichNmId = msg.nm_id || null;
  collectMode = ["new", "refresh", "all", "watch"].includes(msg.mode) ? msg.mode : "new";
  await beginRun("enrich");
  clearCaptchaNotice();
  await closeOwnTabs("enrich");
  await closeOwnTabs("search");   // застрявшие вкладки мёртвого поиска тоже чистим
  await saveLoopState();
  console.log(`[ENRICH] старт: mode=${collectMode}${enrichNmId ? ` nm=${enrichNmId}` : " (все)"}`);
  processNext();
}

// Стоп/смена режима: текущую карточку репортим ошибкой (вернётся в pending)
// и закрываем вкладки потока — иначе после переключения на поиск «старая»
// карточка продолжает собираться на глазах и выглядит как конфликт.
async function stopCollectLoop() {
  await loopReady;
  if (!running) return;
  running = false;
  const nm = currentEnrichNm;
  currentEnrichNm = null;
  if (nm) {
    try {
      await api("/api/ext/error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nm_id: nm, error: "interrupted" }),
      });
    } catch {}
  }
  console.log("[ENRICH] стоп" + (nm ? ` (карточка ${nm} вернётся в pending)` : ""));
  await closeOwnTabs("enrich");
  await saveLoopState();
}

async function startSearchLoop(msg) {
  await loopReady;
  await stopCollectLoop();
  await stopSearchLoop();
  searching = true;
  searchNmId = msg.nm_id || null;
  searchFilterSubjects = msg.filterSubjects || null;
  searchSource = msg.source || "seo";
  await beginRun("search", searchSource);
  searchSources = new Set();
  handledTabs.clear();   // новый заход — прежние вкладки больше не актуальны
  clearCaptchaNotice();
  await closeOwnTabs("search");
  await saveLoopState();
  console.log(
    `[SEARCH] старт: source=${searchSource}` +
      (searchNmId ? ` nm=${searchNmId}` : " (все)") +
      (searchFilterSubjects ? " + фильтр субъектов" : "")
  );
  searchNext();
}

// Элемент очереди репортится ошибкой (вернётся в pending), вкладки потока
// закрываем — их результат мы уже не примем.
async function stopSearchLoop() {
  await loopReady;
  if (!searching && !searchQueue) return;
  searching = false;
  clearTimeout(searchWatchdog);
  if (searchQueue) await reportSearchError();
  console.log("[SEARCH] стоп" + (searchQueue ? " (элемент очереди вернётся в pending)" : ""));
  await closeOwnTabs("search");
  handledTabs.clear();
  await saveLoopState();
}

// === ENRICH MODE ===

// Бейдж: во время очереди — pending, в покое — собрано за сессию (зелёный).
async function refreshIdleBadge() {
  if (running || searching) return;
  if (Date.now() < (badgeDoneUntil || 0)) return;   // только что закончили — галочку не затираем
  try {
    const s = await chrome.storage.session.get({ capCount: 0 });
    const n = s.capCount || 0;
    const prog = await getProgress();
    // если знаем объём — показываем «обработано/всего», иначе просто счётчик
    if (prog.mode === "enrich" && prog.total > 0) {
      setProgressBadge(prog.done || n, prog.total, false);
      return;
    }
    setBadge(n ? String(n) : "", n ? "#2e7d32" : "#000");
  } catch {
    setBadge("", "#000");
  }
}

// Авто-capture (§8.4):/api/ext/result отдал 403 (nm не наш) → молча собираем
// контент в общую базу. Переключатель — в popup, по умолчанию включён.
let autoCapCache = null;
async function autoCaptureEnabled() {
  if (autoCapCache === null) {
    try {
      const s = await chrome.storage.local.get({ autoCapture: true });
      autoCapCache = !!s.autoCapture;
    } catch {
      autoCapCache = true;
    }
  }
  return autoCapCache;
}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autoCapture) autoCapCache = !!changes.autoCapture.newValue;
  });
} catch {}

async function captureNow(data, { explicit = false, force = false, allow_own = false } = {}) {
  const r = await api("/api/ext/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(data || {}), explicit, force, allow_own }),
  });
  let result = null;
  try { result = await r.json(); } catch {}
  if (r.status !== 200) {
    console.error("[OBSERVE] capture rejected:", r.status, (result && result.detail) || "");
    return {
      ok: false, status: r.status, result,
      error: (result && result.detail) || (r.status === 401 ? "проверьте токен в настройках popup" : `HTTP ${r.status}`),
    };
  }
  if (!result.skipped) await bumpCapCount();
  return { ok: true, status: r.status, result };
}

async function bumpCapCount() {
  try {
    const s = await chrome.storage.session.get({ capCount: 0 });
    const n = (s.capCount || 0) + 1;
    await chrome.storage.session.set({ capCount: n });
    // счётчики прогресса обновляет поллер (по состоянию очереди на сервере)
    if (!running && !searching) setBadge(String(n), "#2e7d32");
  } catch {}
}

// Состояние карточки ДО сбора: исключена ли она из сбора для нашей компании.
// Раньше состояние жило в sessionStorage и заполнялось только ПОСЛЕ ответа
// сервера — исключённую карточку успевали открыть и прокрутить.
async function capState(nm_id) {
  if (!nm_id) return null;
  try {
    const r = await api(`/api/ext/cap_state?nm_id=${encodeURIComponent(nm_id)}`);
    if (r.status !== 200) return null;
    return await r.json().catch(() => null);
  } catch (e) {
    console.warn("[CAP] cap_state не получен:", e);
    return null;
  }
}

// Явная кнопка «Собрать в WB CMS»: explicit=1 — клик пользователя (в т.ч. пересборка).
async function doCapture(msg) {
  const nm = msg && msg.data && msg.data.nm_id;
  const st = await capState(nm);
  if (st && st.hidden) {
    return {
      ok: true, skipped: true,
      result: { skipped: true, reason: "hidden", nm_id: Number(nm) || 0 },
    };
  }
  return captureNow(msg.data, { explicit: true, force: !!msg.force, allow_own: !!msg.allow_own });
}

// Фоновое наблюдение: человек сам открыл карточку — пишем только то, что уже видно.
// partial=1 → сервер не двигает full_collected_at и не применяет TTL 24 ч.
async function observeCard(data) {
  if (!data || !data.nm_id) return;
  try {
    const r = await api("/api/ext/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, partial: true }),
    });
    if (r.status === 401 || r.status === 403) {
      console.error("[OBSERVE] observe rejected:", r.status);
      return;
    }
    const res = await r.json().catch(() => null);
    console.log("[OBSERVE] capture →", r.status,
      `sold_out ${data.sold_out}`, JSON.stringify(res));
    if (res && !res.skipped) await bumpCapCount();
  } catch (e) {
    console.error("[OBSERVE] observe failed:", e);
  }
}

// Наблюдение выдачи: человек сам что-то искал — сохраняем фразу, позиции и цены.
async function observeSearch(phrase, products, search_stamp) {
  if (!phrase || !products || !products.length) {
    console.warn("[SEARCH] пустое наблюдение — не отправляю", phrase, products && products.length);
    return { ok: false, status: 0, error: "empty" };
  }
  try {
    const r = await api("/api/ext/observe_search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase, products, search_stamp: search_stamp || "" }),
    });
    const res = await r.json().catch(() => null);
    console.log("[SEARCH] observe_search →", r.status, JSON.stringify(res));
    if (r.status === 401 || r.status === 403) {
      console.error("[SEARCH] observe_search rejected:", r.status, "(проверьте токен в настройках popup)");
      return { ok: false, status: r.status, error: "токен отклонён" };
    }
    if (res && res.saved) await bumpCapCount();
    return {
      ok: r.status === 200,
      status: r.status,
      saved: (res && res.saved) || 0,
      positions: (res && res.positions) || 0,
      error: r.status === 200 ? "" : (res && res.detail) || `HTTP ${r.status}`,
    };
  } catch (e) {
    console.error("[SEARCH] observe_search failed:", e);
    return { ok: false, status: 0, error: String(e) };
  }
}

// === СЫРЫЕ ОТВЕТЫ ВЫДАЧИ (каталог/фильтры/баннеры/подсказки) ===
// Идут из content_search.js одним сообщением на вид ответа.
// Сервер может быть ещё без /api/ext/search_raw (старый деплой) — тогда
// кладём в очередь и не теряем данные (как с полками).
const RAW_QUEUE_KEY = "searchRawQueue";
const RAW_QUEUE_MAX = 3;
const RAW_BODY_MAX = 4_000_000; // байт; каталог ~150-300 КБ, фильтры/полки ~10-50 КБ

async function rawQueueGet() {
  try {
    const s = await chrome.storage.local.get({ [RAW_QUEUE_KEY]: [] });
    return Array.isArray(s[RAW_QUEUE_KEY]) ? s[RAW_QUEUE_KEY] : [];
  } catch {
    return [];
  }
}
async function rawQueuePush(payload) {
  try {
    const q = await rawQueueGet();
    q.push(payload);
    while (q.length > RAW_QUEUE_MAX) q.shift();
    await chrome.storage.local.set({ [RAW_QUEUE_KEY]: q });
    console.warn(`[SEARCH-RAW] не отправлено, в очереди ${q.length}/${RAW_QUEUE_MAX}`);
  } catch {}
}
async function rawQueueSet(q) {
  try {
    await chrome.storage.local.set({ [RAW_QUEUE_KEY]: q });
  } catch {}
}

async function postSearchRaw(data) {
  let body;
  try {
    body = JSON.stringify(data);
  } catch {
    return { ok: false, status: 0, error: "serialize" };
  }
  if (body.length > RAW_BODY_MAX) return { ok: false, status: 0, error: "too big" };
  try {
    const r = await api("/api/ext/search_raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const res = await r.json().catch(() => null);
    if (r.status === 200) {
      console.log("[SEARCH-RAW] сохранено:", body.length, "б", JSON.stringify(res));
      return { ok: true, status: 200, result: res };
    }
    const detail = (res && res.detail) || `HTTP ${r.status}`;
    if (r.status === 404) {
      console.warn("[SEARCH-RAW] /api/ext/search_raw нет на сервере — нужен деплой бэкенда");
    } else if (r.status === 409) {
      console.warn("[SEARCH-RAW] сервер отклонил (контракт/формат):", detail);
    } else if (r.status === 401 || r.status === 403) {
      console.error("[SEARCH-RAW] токен:", r.status, detail);
    } else {
      console.warn("[SEARCH-RAW] rejected:", r.status, detail);
    }
    return { ok: false, status: r.status, result: res, error: detail };
  } catch (e) {
    console.warn("[SEARCH-RAW] сеть:", e);
    return { ok: false, status: 0, error: String(e) };
  }
}

let rawFlushing = false;
async function flushRawQueue() {
  if (rawFlushing) return;
  rawFlushing = true;
  try {
    let q = await rawQueueGet();
    while (q.length) {
      const next = q[0];
      const r = await postSearchRaw(next);
      if (!r.ok) break;
      q = q.slice(1);
      await rawQueueSet(q);
    }
  } finally {
    rawFlushing = false;
  }
}

async function sendSearchRaw(data) {
  if (!data || !data.raw || !Object.keys(data.raw).length) {
    return { ok: false, status: 0, error: "empty" };
  }
  const out = await postSearchRaw(data);
  if (!out.ok) {
    // 404/409 — серверу нужен деплой: данные подождём в очереди (лучше потерять
    // свежесть, чем содержимое).
    if (out.status === 404 || out.status === 409 || out.status === 0) {
      await rawQueuePush(data);
      return { ...out, queued: true };
    }
    return out;
  }
  void flushRawQueue();
  return out;
}

// === SHELVES (полки / дубликаты / клипы) ===
// Приходят пачкой с карточки (content_shelf.js). Сервер может быть ещё без
// /api/ext/shelves (старый деплой) — тогда кладём в очередь и не теряем данные.
const SHELF_QUEUE_KEY = "shelfQueue";
const SHELF_QUEUE_MAX = 5;
const SHELF_BODY_MAX = 3_500_000; // байт; WB-полка целиком ~0,3–0,6 МБ
let shelfFlushing = false;

async function shelfQueueGet() {
  try {
    const s = await chrome.storage.local.get({ [SHELF_QUEUE_KEY]: [] });
    return Array.isArray(s[SHELF_QUEUE_KEY]) ? s[SHELF_QUEUE_KEY] : [];
  } catch {
    return [];
  }
}

async function shelfQueuePush(payload) {
  try {
    const q = await shelfQueueGet();
    q.push(payload);
    while (q.length > SHELF_QUEUE_MAX) q.shift();
    await chrome.storage.local.set({ [SHELF_QUEUE_KEY]: q });
    console.warn(`[SHELF] не отправлено, в очереди ${q.length}/${SHELF_QUEUE_MAX}`);
  } catch {}
}

async function shelfQueueSet(q) {
  try {
    await chrome.storage.local.set({ [SHELF_QUEUE_KEY]: q });
  } catch {}
}

// Обрезаем payload до разумного размера: лучше сохранить 150 позиций полки,
// чем не сохранить ничего из-за 413.
function trimShelfPayload(data) {
  const hasClips = !!(data && Array.isArray(data.clips) && data.clips.length);
  // Клипы глобальны (nm_id=0 допустим) — их нельзя терять на страницах без карточки.
  if (!data || (!data.nm_id && !hasClips)) return null;
  const cut = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
  const out = {
    ...data,
    shelves: cut(data.shelves, 20).map((s) => ({ ...s, items: cut(s.items, 300) })),
    offers: cut(data.offers, 10).map((o) => ({ ...o, items: cut(o.items, 100) })),
    clips: cut(data.clips, 200),
  };
  let body = "";
  try {
    body = JSON.stringify(out);
  } catch {
    return null;
  }
  if (body.length <= SHELF_BODY_MAX) return out;
  out.clips = [];
  for (const s of out.shelves) s.items = s.items.slice(0, 100);
  for (const o of out.offers) o.items = o.items.slice(0, 50);
  try {
    body = JSON.stringify(out);
  } catch {
    return null;
  }
  if (body.length > SHELF_BODY_MAX) return null;
  return out;
}

async function postShelves(data) {
  let body;
  try {
    body = JSON.stringify(data);
  } catch {
    return { ok: false, status: 0, error: "serialize" };
  }
  try {
    const r = await api("/api/ext/shelves", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const res = await r.json().catch(() => null);
    if (r.status === 200) {
      console.log("[SHELF] saved:", body.length, "b", JSON.stringify(res));
      return { ok: true, status: 200, result: res };
    }
    const detail = (res && res.detail) || `HTTP ${r.status}`;
    if (r.status === 404) {
      console.warn("[SHELF] /api/ext/shelves нет на сервере — нужен деплой бэкенда и миграции");
    } else if (r.status === 401 || r.status === 403) {
      console.error("[SHELF] токен:", r.status, detail);
    } else {
      console.warn("[SHELF] rejected:", r.status, detail);
    }
    return { ok: false, status: r.status, result: res, error: detail };
  } catch (e) {
    console.warn("[SHELF] сеть:", e);
    return { ok: false, status: 0, error: String(e) };
  }
}

async function flushShelfQueue() {
  if (shelfFlushing) return;
  shelfFlushing = true;
  try {
    let q = await shelfQueueGet();
    while (q.length) {
      const next = q[0];
      const r = await postShelves(next);
      if (!r.ok) break;
      q = q.slice(1);
      await shelfQueueSet(q);
    }
  } finally {
    shelfFlushing = false;
  }
}

async function sendShelves(data) {
  const payload = trimShelfPayload(data);
  if (!payload) {
    console.warn("[SHELF] пустой/слишком большой payload — пропуск");
    return { ok: false, status: 0, error: "empty payload" };
  }
  const out = await postShelves(payload);
  if (!out.ok) {
    await shelfQueuePush(payload);
    return { ...out, queued: true };
  }
  void flushShelfQueue();
  return out;
}

/** Сырой ответ полки карточки → /api/ext/shelves-raw (сервер пишет файл). */
async function sendShelfRaw(data) {
  const d = data || {};
  if (!d.raw || !d.nm_id) return { ok: false, error: "empty raw" };
  try {
    const r = await api("/api/ext/shelves-raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nm_id: d.nm_id,
        url: d.url || "",
        kind: d.kind || "recom",
        raw: d.raw,
        stamp: d.stamp || "",
      }),
    });
    if (r.status === 200) {
      const j = await r.json().catch(() => null);
      console.log("[SHELF] сырой ответ сохранён:", (j && j.file) || "ok");
      return { ok: true, status: r.status, result: j };
    }
    console.warn("[SHELF] сырой ответ отклонён:", r.status);
    return { ok: false, status: r.status };
  } catch (e) {
    console.warn("[SHELF] сырой ответ не отправлен:", e);
    return { ok: false, status: 0, error: String(e) };
  }
}

// === ПРОГРЕСС СБОРА ===
// Живёт в storage.session: переживает перезапуск service worker (MV3) и
// доступно попапу для показа «обработано X из Y · сейчас: … · осталось ~Z мин».
const PROGRESS_KEY = "collectProgress";
let badgeDoneTimer = null;
let badgeDoneUntil = 0;   // до этого времени бейдж с галочкой не трогаем

async function setProgress(patch) {
  try {
    const cur = (await chrome.storage.session.get({ [PROGRESS_KEY]: {} }))[PROGRESS_KEY] || {};
    const next = { ...cur, ...patch, at: Date.now() };
    await chrome.storage.session.set({ [PROGRESS_KEY]: next });
    try { chrome.action.setTitle({ title: progressTitle(next) }); } catch {}
    // Плашка прогресса живёт только в той вкладке, из которой запустили сбор.
    const tabId = next.sourceTabId;
    if (tabId) {
      try { await chrome.tabs.sendMessage(tabId, { type: "WB_PROGRESS", prog: next }); } catch {}
    }
    return next;
  } catch {
    return null;
  }
}

// Поллер прогресса: «обработано» считаем по серверным счётчикам, от базы
// запуска. Локальный счётчик собранных карточек для этого не годится — он
// не связан с состоянием очереди на сервере.
let progressTimer = null;
async function pollProgress() {
  try {
    const prog = await getProgress();
    if (!prog || !prog.mode) {
      try { chrome.action.setTitle({ title: "SelBI parser" }); } catch {}
      return;
    }
    if (prog.finished) {
      // Готово — поллер больше не нужен (его интервал и держал SW живым).
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      try { chrome.action.setTitle({ title: "SelBI parser" }); } catch {}
      return;
    }
    const url = prog.mode === "search"
      ? `/api/ext/search_status?source=${searchSource || "seo"}`
      : enrichStatusUrl();
    const r = await api(url);
    if (r.status !== 200) return;
    const d = await r.json();
    // «в очереди» — сколько ждёт сейчас (сервер), «обработано» — локальный
    // счётчик этого запуска (его не сбивает пересев очереди).
    const total = (d.pending || 0) + (d.processing || 0);
    const done = prog.done || 0;
    await setProgress({ total });
    setProgressBadge(done, total, false);
  } catch {}
}

// Тултип иконки: что сейчас делает расширение (прогресс видно при наведении).
function progressTitle(prog) {
  const base = "SelBI parser";
  if (!prog || !prog.mode) return base;
  const mode = prog.mode === "enrich" ? "сбор карточек" : "поиск";
  if (prog.finished) return `${base} — ${mode}: готово, обработано ${prog.done || 0}`;
  const parts = [`${base} — ${mode}: обработано ${prog.done || 0}`];
  if (prog.total) parts.push(`в очереди ${prog.total}`);
  if (prog.current) parts.push(`сейчас: ${prog.current}`);
  return parts.join(" · ");
}

// +1 к «обработано» текущего запуска (успех, ошибка или таймаут карточки)
async function bumpRunDone() {
  try {
    const prog = await getProgress();
    await setProgress({ done: (prog.done || 0) + 1 });
  } catch {}
}

function startProgressPoller() {
  if (progressTimer) return;
  progressTimer = setInterval(pollProgress, 5000);
  pollProgress();
}

// Начало запуска: запоминаем вкладку-источник (та, что была активна под курсором)
// и базу счётчиков — прогресс считаем ОТ НЕЁ, а не от всей истории очереди.
async function beginRun(mode, source) {
  let tabId = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs && tabs[0] ? tabs[0].id : null;
  } catch {}
  let baseDone = 0;
  let baseTotal = 0;
  try {
    const url = mode === "search"
      ? `/api/ext/search_status?source=${source}`
      : enrichStatusUrl();
    const r = await api(url);
    const d = await r.json();
    baseDone = d.done || 0;
    baseTotal = (d.pending || 0) + (d.processing || 0);
  } catch {}
  await setProgress({
    mode,
    sourceTabId: tabId,
    baseDone,
    baseTotal,
    done: 0,
    total: baseTotal,
    current: "",
    startedAt: Date.now(),
    finished: false,
  });
  startProgressPoller();
}

async function getProgress() {
  try {
    return (await chrome.storage.session.get({ [PROGRESS_KEY]: {} }))[PROGRESS_KEY] || {};
  } catch {
    return {};
  }
}

// «Осталось ~N мин» по среднему времени на единицу
function etaText(prog) {
  if (!prog || !prog.total || !prog.done || !prog.startedAt) return "";
  const per = (Date.now() - prog.startedAt) / prog.done;
  const left = Math.max(0, (prog.total - prog.done) * per);
  const min = Math.round(left / 60000);
  if (min < 1) return "осталось меньше минуты";
  if (min < 60) return `осталось ~${min} мин`;
  return `осталось ~${Math.round(min / 60)} ч`;
}

// Бейдж «X/Y» во время работы и «✓» на 10 секунд по окончании.
function setProgressBadge(done, total, finished) {
  try {
    if (badgeDoneTimer) { clearTimeout(badgeDoneTimer); badgeDoneTimer = null; }
    if (finished) {
      badgeDoneUntil = Date.now() + 10000;
      setBadge("✓", "#2e7d32");
      badgeDoneTimer = setTimeout(() => { badgeDoneUntil = 0; refreshIdleBadge(); }, 10000);
      return;
    }
    if (total > 0) setBadge(`${done || 0}/${total}`, "#2e7d32");
    else if (done) setBadge(String(done), "#2e7d32");
    else setBadge("", "#000");
  } catch {}
}

function setBadge(text, color) {
  try { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color }); } catch {}
}

// События для popup (DONE/SEARCH_DONE/CAPTCHA). Popup обычно закрыт — без
// .catch MV3 кидает «Uncaught (in promise): Could not establish connection»
// в консоль service worker (выглядит как падение, им не является).
function notifyPopup(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

function clearCaptchaNotice() {
  setBadge("", "#000");
  try { chrome.action.setTitle({ title: "SelBI parser" }); } catch {}
}

// WB показал антибот-страницу. Гасим ТОЛЬКО поток, чья вкладка словила капчу
// (второй продолжает — сам остановится, если тоже поймает), текущую карточку/
// запрос репортим ошибкой, вкладку оставляем открытой — пользователь решает
// капчу руками, после чего запускает поток снова.
async function handleCaptcha(data, tId) {
  await loopReady;
  const kind = (tId && ownTabs.get(tId)) || "";
  const stoppedEnrich = kind === "enrich" && running;
  const stoppedSearch = kind === "search" && searching;
  if (!stoppedEnrich && !stoppedSearch) return;
  console.warn(
    `[CAPTCHA] во вкладке ${kind || "неизвестной"}: ${String((data && (data.phrase || data.nm)) || "")} — поток останавливается`
  );
  try { chrome.action.setTitle({ title: "SelBI parser: решите капчу в открытой вкладке" }); } catch {}
  setBadge("CAP", "#c62828");

  // Капчу-вкладку отдаём человеку: из ownTabs/everOwnTabs убираем, иначе
  // следующий «Старт» закроет её вместе с решённой капчей, а результаты
  // из неё перестали бы считаться наблюдением.
  ownTabs.delete(tId);
  everOwnTabs.delete(tId);

  if (stoppedEnrich) {
    running = false;
    const nm = Number(data && data.nm) || currentEnrichNm || 0;
    currentEnrichNm = null;
    if (nm) {
      try {
        await api("/api/ext/error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nm_id: nm, error: "WB captcha" }),
        });
      } catch {}
    }
    await closeOwnTabs("enrich");
  }
  if (stoppedSearch) {
    searching = false;
    clearTimeout(searchWatchdog);
    await reportSearchError();
    await closeOwnTabs("search");
  }
  await saveLoopState();

  if (tId) {
    try { await chrome.tabs.update(tId, { active: true }); } catch {}
  }
  try { notifyPopup({ type: "CAPTCHA", data: { ...(data || {}), stopped: { enrich: stoppedEnrich, search: stoppedSearch } } }); } catch {}
}

async function handleResult(data, tId) {
  await loopReady;
  let status = 0;
  let captured = null;
  let error = "";
  // Payload в SW-консоль: вкладка карточки закрывается сразу после сбора,
  // а service worker живёт — отсюда видно, что реально уехало на сервер.
  console.log("[ENRICH] result payload:",
    `nm ${data && data.nm_id}`, `price ${data && data.price}`,
    `sold_out ${data && data.sold_out}`);
  try {
    const r = await api("/api/ext/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    status = r.status;
    if (status === 401 || status === 403) {
      let detail = "";
      try { const b = await r.json(); detail = b && b.detail ? String(b.detail) : ""; } catch {}
      if (status === 403 && (await autoCaptureEnabled())) {
        captured = await captureNow(data, { explicit: false });
        if (!captured.ok) error = captured.error || "";
      } else {
        error = detail || "проверьте токен в настройках popup";
        console.error("[ENRICH] result rejected:", status, error);
      }
    }
  } catch (e) {
    console.error("[ENRICH] result save failed:", e);
    error = String(e);
  }
  {
    const descLen = data && typeof data.description === "string" ? data.description.length : 0;
    const chrCnt = data && Array.isArray(data.characteristics) ? data.characteristics.length : 0;
    console.log(
      `[ENRICH] карточка ${data && data.nm_id}: ` +
        (status === 200 ? "сохранено" : captured && captured.ok ? "сохранено (auto-capture)" : "НЕ сохранено") +
        ` · HTTP ${status}` +
        (error ? ` · ${error}` : "") +
        ` · desc ${descLen} симв · хар-к ${chrCnt}`
    );
  }
  if (enrichWatchdog) { clearTimeout(enrichWatchdog); enrichWatchdog = null; }
  if (status === 200 || captured) bumpRunDone();
  if (tId && ownTabs.get(tId) === "enrich" && !DEBUG) {
    try { await chrome.tabs.remove(tId); } catch {}
    ownTabs.delete(tId);
    everOwnTabs.delete(tId);
  }
  await saveLoopState();
  if (running && !DEBUG) {
    try {
      const r = await api(enrichStatusUrl());
      const d = await r.json();
      const cnt = collectMode === "refresh"
        ? (d.need_update || 0)
        : collectMode === "all"
          ? (d.pending || 0) + (d.need_update || 0)
          : (d.pending || 0);
      setBadge(cnt ? String(cnt) : "", "#cb11ab");
    } catch {}
    setTimeout(processNext, enrichGap());
  } else {
    await refreshIdleBadge();
  }
  return { ok: status === 200, status, captured, error };
}

function enrichNextUrl() {
  const params = new URLSearchParams();
  if (enrichNmId) params.set("nm_id", enrichNmId);
  params.set("mode", collectMode || "new");
  return `/api/ext/next?${params.toString()}`;
}

// Счётчики очереди enrich. Режим «SEO-мониторинг» (source='watch') — своя
// очередь, общая куча конкурентов в её счётчики не входит.
function enrichStatusUrl() {
  return collectMode === "watch"
    ? "/api/ext/status?source=watch"
    : "/api/ext/status";
}

// Страховка: карточка не отчиталась за 3 минуты (WB не отрисовал, капча,
// редирект) — считаем её битой, отчитываемся ошибкой и идём к следующей.
let enrichWatchdog = null;
function armEnrichWatchdog() {
  if (enrichWatchdog) clearTimeout(enrichWatchdog);
  enrichWatchdog = setTimeout(async () => {
    enrichWatchdog = null;
    if (!running) return;
    const nm = currentEnrichNm;
    if (!nm) return;
    console.warn("[ENRICH] watchdog: карточка " + nm + " не отчиталась за 3 мин — пропускаем");
    try {
      await api("/api/ext/error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nm_id: nm, error: "таймаут сбора карточки" }),
      });
    } catch {}
    for (const [id, kind] of [...ownTabs]) {
      if (kind !== "enrich") continue;
      ownTabs.delete(id);
      everOwnTabs.delete(id);
      try { await chrome.tabs.remove(id); } catch {}
    }
    currentEnrichNm = null;
    bumpRunDone();
    processNext();
  }, 3 * 60 * 1000);
}

async function processNext() {
  if (!running) return;
  // Уже ждём результат (карточка открыта) — повторный вызов ничего не открывает.
  if ([...ownTabs.values()].includes("enrich")) return;
  try {
    const resp = await api(enrichNextUrl());
    const { nm_id } = await resp.json();
    if (!nm_id) {
      running = false;
      currentEnrichNm = null;
      console.log("[ENRICH] очередь пуста — стоп");
      {
        const prog = await getProgress();
        const total = prog.total || 0;
        const done = prog.done || 0;
        await setProgress({ mode: "enrich", current: "", done, total, finished: true });
        setProgressBadge(done, total, true);
      }
      await refreshIdleBadge();
      notifyPopup({ type: "DONE" });
      return;
    }
    currentEnrichNm = nm_id;
    // Карточка исключена из сбора для нашей компании? — вкладку не открываем:
    // сервер всё равно не обновит контент, а мы бы потратили вкладку и скролл.
    const st = await capState(nm_id);
    if (st && st.hidden) {
      console.log(`[ENRICH] карточка ${nm_id} исключена из сбора — пропускаем`);
      try {
        await api("/api/ext/skip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nm_id }),
        });
      } catch (e) {
        console.warn("[ENRICH] не отпустили карточку в очередь:", e);
      }
      currentEnrichNm = null;
      bumpRunDone();
      if (running && !DEBUG) setTimeout(processNext, enrichGap());
      return;
    }
    armEnrichWatchdog();
    {
      const prog = await getProgress();
      await setProgress({
        mode: "enrich",
        current: `nm ${nm_id}`,
        currentNm: nm_id,
        startedAt: prog.mode === "enrich" && prog.startedAt ? prog.startedAt : Date.now(),
      });
    }
    console.log(`[ENRICH] следующая карточка: ${nm_id} → открываю вкладку`);
    const tab = await chrome.tabs.create({
      url: `https://www.wildberries.ru/catalog/${nm_id}/detail.aspx`,
      active: true,
    });
    ownTabs.set(tab.id, "enrich");
    everOwnTabs.add(tab.id);
    await saveLoopState();
  } catch (e) {
    console.error("[ENRICH] /next failed:", e);
    running = false;
  }
}

// === SEARCH MODE ===

async function getSearchNextUrl() {
  const params = new URLSearchParams();
  if (searchNmId) params.set("nm_id", searchNmId);
  if (searchSource) params.set("source", searchSource);
  const qs = params.toString();
  return qs ? `/api/ext/search_next?${qs}` : `/api/ext/search_next`;
}

async function handleSearchResult(data, tId) {
  await loopReady;
  const { phrase, products } = data;
  // Вкладка очереди карточек не имеет отношения к поиску: контент с неё
  // (рекомендации на карточке фонового сбора) не должен записываться как
  // выдача — тем более как элемент очереди.
  if (tId && ownTabs.get(tId) === "enrich") {
    console.warn("[SEARCH] WB_SEARCH_RESULT из вкладки карточки — игнор");
    return { ok: true, skipped: true, note: "enrich-tab" };
  }
  const isOwnTab = !!(tId && ownTabs.get(tId) === "search");
  let out = { ok: false, status: 0, error: "" };
  // Повторный результат от вкладки — обычно дубль, НО если ждали апдейт
  // скролл-досбора картинок — это обновление, ветка ниже (searchAwaitTabs).
  if (isOwnTab && handledTabs.has(tId) && !searchAwaitTabs.has(tId)) {
    console.log("[SEARCH] повторный результат из вкладки расширения — игнор");
    return { ok: true, skipped: true, note: "duplicate" };
  }
  if (searchQueue && isOwnTab) {
    // Не та фраза: вкладка ушла на другой запрос — элемент очереди не расходуем,
    // его вернёт в pending тайм-аут ожидания (searchWatchdog).
    if (normPhrase(phrase) !== normPhrase(searchQueue.phrase)) {
      console.warn(`[SEARCH] фраза не совпала («${phrase}» ≠ «${searchQueue.phrase}») — игнор`);
      return { ok: true, skipped: true, note: "phrase-mismatch" };
    }
    const qsrc = searchQueue.source || searchSource;
    const qnm = searchQueue.nm_id;
    handledTabs.add(tId);
    clearTimeout(searchWatchdog);
    try {
      const r = await api("/api/ext/search_result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queue_id: searchQueue.queue_id,
          nm_id: qnm,
          phrase: searchQueue.phrase,
          source: qsrc,
          products,
          search_stamp: data.search_stamp || "",
        }),
      });
      if (r.ok && qsrc === "compquery" && qnm) searchSources.add(qnm);
      if (r.status === 401 || r.status === 403) console.error("[SEARCH] сохранение отклонено:", r.status, "(проверьте токен в настройках popup)");
      try {
        const st = await api(`/api/ext/search_status?source=${qsrc}`);
        const d = await st.json();
        const prog = await getProgress();
        // Прогресс — по текущему запуску: сколько сделали минус база на старте
        const done = Math.max(0, (d.done || 0) - (prog.baseDone || 0));
        const total = prog.baseTotal || 0;
        await setProgress({ mode: "search", current: "", done, total });
        setProgressBadge(done, total, false);
      } catch {}
      out = {
        ok: r.status === 200,
        status: r.status,
        saved: (products || []).length,
        queue: true,
        error: r.status === 200 ? "" : `HTTP ${r.status}`,
      };
    } catch (e) {
      console.error("[SEARCH] сохранение не отправлено:", e);
      out = { ok: false, status: 0, error: String(e) };
    }
    // Контекст для апдейт-POST при досборе картинок (searchQueue обнуляем)
    const updCtx = {
      queue_id: searchQueue.queue_id,
      nm_id: qnm,
      phrase: searchQueue.phrase,
      source: qsrc,
      stamp: data.search_stamp || "",
    };
    searchQueue = null;
    // Дисбор картинок: держим вкладку до апдейта/таймаута. Закрывать и
    // планировать следующую фразу будет finishSearchUpdate.
    if (out.ok && tId && !DEBUG) {
      await armScrollUpdate(tId, updCtx);
    }
  } else if (isOwnTab && searchAwaitTabs.has(tId)) {
    // Апдейт досбора картинок (скролл): досохраняем на сервер и закрываем вкладку
    const ctx = searchUpdateCtx.get(tId) || {};
    console.log(`[SEARCH] апдейт досбора («${phrase}»): ${(products || []).length} позиций`);
    try {
      const r = await api("/api/ext/search_result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queue_id: ctx.queue_id,
          nm_id: ctx.nm_id,
          phrase: ctx.phrase || phrase,
          source: ctx.source || searchSource,
          products,
          search_stamp: data.search_stamp || ctx.stamp || "",
        }),
      });
      if (r.status === 401 || r.status === 403) {
        console.error("[SEARCH] апдейт отклонён:", r.status, "(проверьте токен в настройках popup)");
      }
      out = { ok: r.status === 200, status: r.status, saved: (products || []).length, update: true };
    } catch (e) {
      console.error("[SEARCH] апдейт не отправлен:", e);
      out = { ok: false, status: 0, error: String(e) };
    }
    await finishSearchUpdate(tId);
    return out;
  } else if (isOwnTab) {
    // вкладка расширения, очередь по этой фразе уже обработана — это дубль
    console.log("[SEARCH] дубль результата из вкладки расширения — игнор");
    return { ok: true, skipped: true, note: "duplicate" };
  } else if (tId && everOwnTabs.has(tId)) {
    // Поздний результат из нашей закрытой/переведённой вкладки (рестарт SW,
    // смена режима) — человеческим поиском его считать нельзя.
    console.log("[SEARCH] поздний результат из вкладки расширения — игнор");
    out = { ok: true, skipped: true, note: "stale-own-tab" };
  } else if (products && products.length) {
    // Поиск сделал человек (не расширение) — сохраняем как наблюдение.
    out = await observeSearch(phrase, products, data.search_stamp);
  }

  if (isOwnTab && !DEBUG) {
    if (searchAwaitTabs.has(tId)) {
      // ждём апдейт картинок: вкладку закроет finishSearchUpdate — он же
      // запускает следующую фразу (searchNext)
    } else {
      try { await chrome.tabs.remove(tId); } catch {}
      ownTabs.delete(tId);
      everOwnTabs.delete(tId);
      if (searching && !DEBUG) setTimeout(searchNext, searchGap());
    }
  }
  await saveLoopState();
  return out;
}

async function reportSearchError() {
  if (!searchQueue) return;
  try {
    await api("/api/ext/search_error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queue_id: searchQueue.queue_id,
        nm_id: searchQueue.nm_id,
        phrase: searchQueue.phrase,
        source: searchQueue.source || searchSource,
      }),
    });
  } catch {}
  searchQueue = null;
  await saveLoopState();
}

// Тайм-аут ожидания результата: WB не отрисовал выдачу, вкладка погибла или
// контент скрипт не сработал. Иначе очеред молчит вечно (кнопочно найденная
// фраза висит в «Выполняется» до серверного таймаута).
function armSearchWatchdog() {
  clearTimeout(searchWatchdog);
  searchWatchdog = setTimeout(async () => {
    searchWatchdog = null;
    await loopReady;
    if (!searchQueue) return;
    console.warn("[SEARCH] таймаут ожидания результата — элемент вернётся в pending");
    await reportSearchError();
    await closeOwnTabs("search");
    await saveLoopState();
    // Следующий шаг открываем только если цикл ещё семантически жив
    // (пользователь его запускал в этой жизни воркера).
    if (searching) setTimeout(searchNext, searchGap());
  }, 90000);
}

async function searchNext() {
  if (!searching) return;
  // Уже ждём результат текущего шага — повторный вызов ничего не открывает.
  if (searchQueue) return;
  if ([...ownTabs.values()].includes("search")) {
    // Вкладка выдачи без элемента очереди — устаревшая (её результат принят
    // или потерян): закрываем и идём за следующей фразой.
    await closeOwnTabs("search");
  }
  try {
    const resp = await api(await getSearchNextUrl());
    const data = await resp.json();
    // Фраза из очереди «Поисковые фразы» может быть без карточки (nm_id=0) —
    // очередь пуста только если нет ни того, ни другого.
    if (!data.nm_id && !data.phrase) {
      searching = false;
      clearTimeout(searchWatchdog);
      {
        const prog = await getProgress();
        const total = prog.total || 0;
        const done = prog.done || 0;
        await setProgress({ mode: "search", current: "", done, total, finished: true });
        setProgressBadge(done, total, true);
      }
      await refreshIdleBadge();
      await saveLoopState();
      const seedSources = new Set(searchSources);
      if (searchNmId) seedSources.add(searchNmId);
      for (const sid of seedSources) {
        try {
          await api("/api/ext/seed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_nm_id: sid }),
          });
        } catch {}
      }
      notifyPopup({ type: "SEARCH_DONE" });
      console.log("[SEARCH] очередь пуста — стоп");
      return;
    }

    const phrase = data.phrase;
    searchQueue = { queue_id: data.queue_id, nm_id: data.nm_id, phrase, source: searchSource };
    // Прогресс: что собираем прямо сейчас
    const prog = await getProgress();
    await setProgress({
      mode: "search",
      current: phrase,
      currentNm: data.nm_id || 0,
      startedAt: prog.mode === "search" && prog.startedAt ? prog.startedAt : Date.now(),
    });
    console.log(`[SEARCH] следующая фраза: «${phrase}» (source=${searchSource}, nm=${data.nm_id}) → открываю вкладку`);
    let searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(phrase)}&sort=popular`;
    if (searchFilterSubjects) searchUrl += "&xsubject=" + encodeURIComponent(searchFilterSubjects);

    const tab = await chrome.tabs.create({ url: searchUrl, active: true });
    ownTabs.set(tab.id, "search");
    everOwnTabs.add(tab.id);
    armSearchWatchdog();
    await saveLoopState();
  } catch (e) {
    console.error("[SEARCH] search_next не отправлен:", e);
    await reportSearchError();
    if (searching) setTimeout(searchNext, searchGap());
  }
}

// Добор очереди полок после рестарта service worker (раз в жизни воркера).
void flushShelfQueue();
