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

async function api(path, opts = {}) {
  const { server, token } = await cfg();
  const headers = { ...(opts.headers || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  return fetch(server + path, { ...opts, headers });
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
let tabId = null;

// Вкладки, которые открыли МЫ САМИ (очередь/поиск). Только их и закрываем:
// раньше после /result закрывалась любая вкладка, включая ту, где пользователь работал.
const ownTabs = new Set();
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

async function closeOwnTabs() {
  const ids = [...ownTabs];
  ownTabs.clear();
  tabId = null;
  for (const id of ids) {
    try { await chrome.tabs.remove(id); } catch {}
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "WB_MODE") {
    // Вкладка расширения (очередь/поиск) — полный цикл; вкладка человека — пассивный фон.
    const id = sender && sender.tab && sender.tab.id;
    sendResponse({ mode: id && ownTabs.has(id) ? "full" : "passive" });
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
  if (msg.type === "CAPTURE") {
    doCapture(msg)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "WB_SEARCH_RESULT") {
    handleSearchResult(msg.data, sender.tab?.id);
  }
  if (msg.type === "WB_SHELVES") {
    sendShelves(msg.data)
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
    }).catch(e => console.error("diag save failed:", e));
  }
  if (msg.type === "START") {
    running = true;
    enrichNmId = msg.nm_id || null;
    collectMode = ["new", "refresh", "all"].includes(msg.mode) ? msg.mode : "new";
    clearCaptchaNotice();
    closeOwnTabs();
    processNext();
  }
  if (msg.type === "STOP") {
    running = false;
  }
  if (msg.type === "SEARCH_START") {
    searching = true;
    searchNmId = msg.nm_id || null;
    searchFilterSubjects = msg.filterSubjects || null;
    searchSource = msg.source || "seo";
    searchSources = new Set();
    handledTabs.clear();   // новый заход — прежние вкладки больше не актуальны
    clearCaptchaNotice();
    closeOwnTabs();
    searchNext();
  }
  if (msg.type === "SEARCH_STOP") {
    searching = false;
  }
});

// === ENRICH MODE ===

// Бейдж: во время очереди — pending, в покое — собрано за сессию (зелёный).
async function refreshIdleBadge() {
  if (running || searching) return;
  try {
    const s = await chrome.storage.session.get({ capCount: 0 });
    const n = s.capCount || 0;
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
    console.error("capture rejected:", r.status, (result && result.detail) || "");
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
      console.error("observe rejected:", r.status);
      return;
    }
    const res = await r.json().catch(() => null);
    console.log("[OBSERVE] capture →", r.status, JSON.stringify(res));
    if (res && !res.skipped) await bumpCapCount();
  } catch (e) {
    console.error("observe failed:", e);
  }
}

// Наблюдение выдачи: человек сам что-то искал — сохраняем фразу, позиции и цены.
async function observeSearch(phrase, products) {
  if (!phrase || !products || !products.length) {
    console.warn("[SEARCH] пустое наблюдение — не отправляю", phrase, products && products.length);
    return;
  }
  try {
    const r = await api("/api/ext/observe_search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase, products }),
    });
    const res = await r.json().catch(() => null);
    console.log("[SEARCH] observe_search →", r.status, JSON.stringify(res));
    if (r.status === 401 || r.status === 403) {
      console.error("observe_search rejected:", r.status, "(проверьте токен в настройках popup)");
      return;
    }
    if (res && res.saved) await bumpCapCount();
  } catch (e) {
    console.error("observe_search failed:", e);
  }
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

function setBadge(text, color) {
  try { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color }); } catch {}
}

function clearCaptchaNotice() {
  setBadge("", "#000");
  try { chrome.action.setTitle({ title: "WB Competitor Parser" }); } catch {}
}

// WB показал антибот-страницу. Останавливаем оба режима, помечаем текущую
// карточку/запрос ошибкой и оставляем вкладку открытой — пользователь решает
// капчу руками, после чего запускает очередь снова.
async function handleCaptcha(data, tId) {
  if (!running && !searching) return;
  if (!tId || !ownTabs.has(tId)) return;
  const wasRunning = running;
  const wasSearching = searching;
  running = false;
  searching = false;
  try { chrome.action.setTitle({ title: "WB CMS: решите капчу в открытой вкладке" }); } catch {}
  setBadge("CAP", "#c62828");

  const nm = Number(data && data.nm) || currentEnrichNm || 0;
  if (wasRunning && nm) {
    try {
      await api("/api/ext/error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nm_id: nm, error: "WB captcha" }),
      });
    } catch {}
  }
  if (wasSearching) await reportSearchError();

  if (tId) {
    try { await chrome.tabs.update(tId, { active: true }); } catch {}
    // Оставляем вкладку пользователю, чтобы он решил капчу. Из ownTabs убираем,
    // иначе следующий «Старт» закроет её вместе с решённой капчей.
    ownTabs.delete(tId);
    tabId = null;
  }
  try { chrome.runtime.sendMessage({ type: "CAPTCHA", data: data || {} }); } catch {}
}

async function handleResult(data, tId) {
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
        console.error("result rejected:", status, error);
      }
    }
  } catch (e) {
    console.error("result save failed:", e);
    error = String(e);
  }
  if (tId && ownTabs.has(tId) && !DEBUG) {
    try { await chrome.tabs.remove(tId); } catch {}
    ownTabs.delete(tId);
  }
  tabId = null;
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
  try {
    const resp = await api(enrichNextUrl());
    const { nm_id } = await resp.json();
    if (!nm_id) {
      running = false;
      currentEnrichNm = null;
      await refreshIdleBadge();
      chrome.runtime.sendMessage({ type: "DONE" });
      return;
    }
    currentEnrichNm = nm_id;
    const tab = await chrome.tabs.create({
      url: `https://www.wildberries.ru/catalog/${nm_id}/detail.aspx`,
      active: true,
    });
    ownTabs.add(tab.id);
    tabId = tab.id;
  } catch (e) {
    console.error("next failed:", e);
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
  const { phrase, products } = data;
  const isOwnTab = !!(tId && ownTabs.has(tId));
  if (isOwnTab && handledTabs.has(tId)) {
    console.log("[SEARCH] повторный результат из вкладки расширения — игнор");
    return;
  }
  if (searchQueue && isOwnTab) {
    const qsrc = searchQueue.source || searchSource;
    const qnm = searchQueue.nm_id;
    handledTabs.add(tId);
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
        }),
      });
      if (r.ok && qsrc === "compquery" && qnm) searchSources.add(qnm);
      if (r.status === 401 || r.status === 403) console.error("search save rejected:", r.status, "(проверьте токен в настройках popup)");
      try { const st = await api(`/api/ext/search_status?source=${qsrc}`); const d = await st.json(); setBadge(d.pending ? String(d.pending) : "", "#2e7d32"); } catch {}
    } catch (e) {
      console.error("search save failed:", e);
    }
    searchQueue = null;
  } else if (isOwnTab) {
    // вкладка расширения, очередь по этой фразе уже обработана — это дубль
    console.log("[SEARCH] дубль результата из вкладки расширения — игнор");
    return;
  } else if (products && products.length) {
    // Поиск сделал человек (не расширение) — сохраняем как наблюдение.
    await observeSearch(phrase, products);
  }

  if (isOwnTab && !DEBUG) {
    try { await chrome.tabs.remove(tId); } catch {}
    ownTabs.delete(tId);
  }
  tabId = null;
  if (searching && !DEBUG && isOwnTab) {
    setTimeout(searchNext, searchGap());
  }
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
}

async function searchNext() {
  if (!searching) return;
  try {
    const resp = await api(await getSearchNextUrl());
    const data = await resp.json();
    if (!data.nm_id) {
      searching = false;
      await refreshIdleBadge();
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
      chrome.runtime.sendMessage({ type: "SEARCH_DONE" });
      return;
    }

    const phrase = data.phrase;
    searchQueue = { queue_id: data.queue_id, nm_id: data.nm_id, phrase, source: searchSource };
    let searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(phrase)}&sort=popular`;
    if (searchFilterSubjects) searchUrl += "&xsubject=" + encodeURIComponent(searchFilterSubjects);

    const tab = await chrome.tabs.create({ url: searchUrl, active: true });
    ownTabs.add(tab.id);
    tabId = tab.id;
  } catch (e) {
    console.error("search next failed:", e);
    await reportSearchError();
    if (searching) setTimeout(searchNext, searchGap());
  }
}

// Добор очереди полок после рестарта service worker (раз в жизни воркера).
void flushShelfQueue();
