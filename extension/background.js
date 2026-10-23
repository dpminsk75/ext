const DEFAULT_SERVER = "http://31.130.204.146:8000";
const DEBUG = false;

// Паузы между карточками/запросами. WB быстро отдаёт капчу, если долбить его
// подряд: 32 карточки по 0.5 с — гарантированный WBAAS-бан. Рандом сбивает
// ровный ритм и выглядит как живой пользователь.
const SEARCH_GAP_MS = [9000, 16000];
const ENRICH_GAP_MS = [5000, 10000];

function rnd(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function searchGap() {
  return rnd(SEARCH_GAP_MS[0], SEARCH_GAP_MS[1]);
}
function enrichGap() {
  return rnd(ENRICH_GAP_MS[0], ENRICH_GAP_MS[1]);
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
          `обновите расширение (http://31.130.204.146:3000/ext/install)`
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
try {
  chrome.tabs.onRemoved.addListener((id) => {
    ownTabs.delete(id);
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
  }
  if (msg.type === "CAPTURE") {
    doCapture(msg)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
  if (msg.type === "WB_SEARCH_RAW") {
    sendSearchRaw(msg.data)
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
  collectMode = ["new", "refresh", "all"].includes(msg.mode) ? msg.mode : "new";
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
    {
      const prog = await getProgress();
      let done = n;
      let total = prog.baseTotal || 0;
      try {
        const st = await api("/api/ext/status");
        const d = await st.json();
        done = Math.max(0, (d.done || 0) - (prog.baseDone || 0));
        if (!total) total = (d.pending || 0) + (d.processing || 0);
      } catch {}
      await setProgress({ mode: "enrich", done, total });
      setProgressBadge(done, total, false);
    }
    if (!running && !searching) setBadge(String(n), "#2e7d32");
  } catch {}
}

// Явная кнопка «Собрать в WB CMS»: explicit=1 снимает is_hidden (§8.5).
async function doCapture(msg) {
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
    console.log("[OBSERVE] capture →", r.status, JSON.stringify(res));
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
      : "/api/ext/status";
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
  try { chrome.action.setTitle({ title: "WB CMS: решите капчу в открытой вкладке" }); } catch {}
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
  if (tId && ownTabs.get(tId) === "enrich" && !DEBUG) {
    try { await chrome.tabs.remove(tId); } catch {}
    ownTabs.delete(tId);
    everOwnTabs.delete(tId);
  }
  await saveLoopState();
  if (running && !DEBUG) {
    try {
      const r = await api("/api/ext/status");
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
        setProgressBadge(done, total, total > 0);
        await setProgress({ mode: "enrich", current: "", done, total, finished: total > 0 });
      }
      await refreshIdleBadge();
      notifyPopup({ type: "DONE" });
      return;
    }
    currentEnrichNm = nm_id;
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
  if (isOwnTab && handledTabs.has(tId)) {
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
    searchQueue = null;
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
    try { await chrome.tabs.remove(tId); } catch {}
    ownTabs.delete(tId);
    everOwnTabs.delete(tId);
  }
  if (searching && !DEBUG && isOwnTab) {
    setTimeout(searchNext, searchGap());
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
        setProgressBadge(done, total, total > 0);
        await setProgress({ mode: "search", current: "", done, total, finished: total > 0 });
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
