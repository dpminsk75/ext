// Полки / дубликаты / клипы WB: принимает перехваченный JSON страницы
// (hook_wb_api.js, канал WB_SHELF_JSON_V1), склеивает страницы полки,
// подписывает полки названиями из DOM, учит словарь `preset_id → подпись`
// и отправляет всё на /api/ext/shelves через background.js.
//
// Ничего не скроллит и не дозапрашивает: только то, что страница уже получила.
(() => {
  const MARK = "WB_SHELF_JSON_V1";
  const STATE_MARK = "WB_SHELF_SENT_V1";
  const DUMP_REQ = "WB_SHELF_DUMP_REQ";
  const DUMP_MARK = "WB_SHELF_DUMP_V1";
  const DICT_KEY = "shelfTitles";
  const SEND_DELAY = 1500;
  const SCAN_DELAY = 800;
  const MIN_DOM_NMS = 4;
  const MAX_SHELF_ITEMS = 300;
  const MAX_SHELVES = 20;
  const VER = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "?";
    }
  })();

  const cardNm = (() => {
    const m = (location.pathname || "").match(/\/catalog\/(\d+)\/detail/i);
    return m ? parseInt(m[1], 10) : 0;
  })();
  // На карточке собираем полки/дубликаты/клипы, на остальных страницах WB — только клипы:
  // api-wibes может дёргаться и вне карточки (лента Wibes, поиск).

  console.log(`[SHELF] content_shelf v${VER} nm=${cardNm || "-"}`);

  const shelves = new Map(); // `${kind}|${preset_id}` -> shelf
  const offers = new Map(); // match_id -> run
  const clips = new Map(); // clip_id -> clip
  let dest = 0;
  let spp = null;
  let dict = {};
  let dictDirty = false;
  let sendTimer = null;
  let scanTimer = null;
  let lastSent = "";

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clamp = (s, n) => String(s || "").slice(0, n);
  const nmOf = (a) => {
    const m = String((a && a.getAttribute("href")) || "").match(/\/catalog\/(\d+)\/detail/i);
    return m ? parseInt(m[1], 10) : 0;
  };

  // Подпись полки не должна быть названием товара/продавца. В WB aria-label
  // карточки выглядит как "ПРОДАВЕЦ/Название" — такие строки отсекаем.
  function titleOk(t) {
    const s = clean(t);
    if (s.length < 3 || s.length > 60) return false;
    if (s.indexOf("/") >= 0 || s.indexOf("₽") >= 0) return false;
    return true;
  }

  // ---------------- словарь подписей (preset_id -> title) ----------------
  try {
    chrome.storage.local.get({ [DICT_KEY]: {} }, (s) => {
      dict = (s && s[DICT_KEY]) || {};
      applyDict();
    });
  } catch {}

  function learn(presetId, title, score) {
    const id = String(presetId || 0);
    if (!presetId || !titleOk(title)) return;
    const prev = dict[id];
    if (prev && prev.t === title && (prev.n || 0) >= 2) return;
    dict[id] = { t: title, n: ((prev && prev.n) || 0) + 1, s: Math.round(score * 100) / 100 };
    dictDirty = true;
  }

  function saveDict() {
    if (!dictDirty) return;
    dictDirty = false;
    try {
      chrome.storage.local.set({ [DICT_KEY]: dict });
    } catch {}
  }

  function applyDict() {
    let changed = false;
    // Чистим словарь от мусора, выученного в 1.13–1.14 (названия товаров и т.п.).
    for (const id of Object.keys(dict)) {
      const d = dict[id];
      if (!d || !titleOk(d.t)) {
        delete dict[id];
        dictDirty = true;
      }
    }
    for (const s of shelves.values()) {
      if (s.title) continue;
      const d = dict[String(s.preset_id || 0)];
      if (d && d.t) {
        s.title = d.t;
        s.title_source = "dict";
        changed = true;
      }
    }
    if (changed) scheduleSend();
  }

  // ---------------- приём JSON ----------------
  function shelfKey(kind, presetId) {
    return `${kind}|${presetId || 0}`;
  }

  function onEnvelope(env) {
    if (!env || !env.kind) return;
    if (env.dest) dest = Number(env.dest) || dest;
    if (env.spp != null) spp = Number(env.spp);

    // Полки/дубликаты имеют смысл только на карточке; клипы — на любой странице WB.
    if (!cardNm && env.kind !== "clips") return;

    if (env.kind === "list") {
      // v4/list — не полка: нет preset_id, нет ранжирования. Для v1 не храним.
      return;
    }
    if (env.kind === "clips") {
      for (const c of env.clips || []) {
        if (c && c.clip_id) clips.set(c.clip_id, c);
      }
      scheduleSend();
      return;
    }
    if (env.kind === "duplicates") {
      onDuplicates(env);
      return;
    }
    onRecom(env);
  }

  function onRecom(env) {
    const key = shelfKey(env.kind, env.preset_id);
    let s = shelves.get(key);
    if (!s) {
      s = {
        kind: env.kind,
        route: env.route || "",
        preset_id: Number(env.preset_id) || 0,
        preset_type: "",
        title: "",
        title_source: "none",
        total_candidates: env.meta && env.meta.total != null ? env.meta.total : null,
        pages_loaded: 0,
        subject_id: env.subject_id || null,
        parent_subject_id: env.parent_subject_id || null,
        imt_id: env.imt_id || null,
        items: new Map(),
      };
      shelves.set(key, s);
    }
    if (env.preset_type && !s.preset_type) s.preset_type = env.preset_type;
    if (env.meta && env.meta.total != null) s.total_candidates = env.meta.total;
    if (env.subject_id && !s.subject_id) s.subject_id = env.subject_id;
    if (env.parent_subject_id && !s.parent_subject_id) s.parent_subject_id = env.parent_subject_id;
    if (env.imt_id && !s.imt_id) s.imt_id = env.imt_id;
    s.pages_loaded = Math.max(s.pages_loaded, Number(env.page) || 1);

    for (const it of env.items || []) {
      if (!it || !it.nm_id) continue;
      s.items.set(it.nm_id, it);
    }
    applyDict();
    scheduleScan();
    scheduleSend();
  }

  function onDuplicates(env) {
    const md = env.meta || {};
    const mid = Number(env.match_id) || 0;
    if (!mid) return;
    let run = offers.get(mid);
    if (!run) {
      run = {
        match_id: mid,
        anchor_nm_id: Number(env.nm_id) || cardNm,
        anchor_supplier_id: env.anchor_supplier_id || null,
        anchor_price: null,
        min_price: md.min_price != null ? md.min_price : null,
        min_price_nm_id: md.min_price_nm_id || null,
        offers_total: md.total != null ? md.total : null,
        benefit: md.benefit || "",
        shard_key: md.shard_key || "",
        shard_query: md.shard_query || "",
        response_type: md.response_type || "",
        items: new Map(),
      };
      offers.set(mid, run);
    }
    if (md.min_price != null) run.min_price = md.min_price;
    if (md.min_price_nm_id) run.min_price_nm_id = md.min_price_nm_id;
    if (md.total != null) run.offers_total = md.total;
    for (const it of env.items || []) {
      if (!it || !it.nm_id) continue;
      run.items.set(it.nm_id, it);
    }
    scheduleSend();
  }

  function onMessage(raw) {
    if (typeof raw !== "string" || raw.indexOf(MARK) < 0) return;
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && msg.type === MARK) onEnvelope(msg);
  }

  window.addEventListener("message", (ev) => onMessage(ev.data));
  document.addEventListener(MARK, (ev) => onMessage(ev && ev.detail));

  // Хук мог поймать ответ до нашего запуска — просим повторить последние конверты.
  try {
    document.dispatchEvent(new Event("WB_SHELF_REPLAY_REQ"));
  } catch {}

  // ---------------- DOM: подписи полок ----------------
  function isVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  }

  function nmLinksIn(box) {
    const out = [];
    const seen = new Set();
    const links = box.querySelectorAll('a[href*="/catalog/"]');
    for (const a of links) {
      const n = nmOf(a);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  function boxTitle(box) {
    const h = box.querySelector("h1,h2,h3,h4,h5");
    if (h) {
      const t = clean(h.textContent);
      if (t && t.length <= 80) return t;
    }
    const tEl = box.querySelector('[class*="title" i], [data-testid*="title" i]');
    if (tEl) {
      const t = clean(tEl.textContent);
      if (t && t.length >= 3 && t.length <= 80) return t;
    }
    return "";
  }

  // Возвращает [{title, nms[]}] — только «настоящие» полки (>=4 карточек).
  function domShelves() {
    const boxes = [];
    const seenBox = new Set();

    const push = (el, nms) => {
      if (!el || seenBox.has(el)) return;
      if (nms.length < MIN_DOM_NMS || nms.length > 80) return;
      seenBox.add(el);
      boxes.push({ el, nms });
    };

    // 1) от заголовков: ближайший вверх контейнер, где уже есть >=4 карточек.
    //    h1 не берём — это название самой карточки, а не подпись полки.
    for (const h of document.querySelectorAll("h2,h3,h4,h5")) {
      const t = clean(h.textContent);
      if (!t || t.length < 3 || t.length > 80) continue;
      if (h.closest("header, nav, footer, [role='dialog']")) continue;
      if (!isVisible(h)) continue;
      let el = h.parentElement;
      for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
        const nms = nmLinksIn(el);
        if (nms.length >= MIN_DOM_NMS) {
          push(el, nms);
          break;
        }
      }
    }

    // 2) запасной путь: контейнеры с характерным классом
    const SEL =
      '[class*="shelf" i], [class*="carousel" i], [class*="similar" i], [class*="recommend" i]';
    let scanned = 0;
    for (const el of document.querySelectorAll(SEL)) {
      if (++scanned > 400) break;
      const nms = nmLinksIn(el);
      if (nms.length >= MIN_DOM_NMS) push(el, nms);
    }

    // 3) вложенные контейнеры выкидываем — остаётся самая узкая «полка»
    const out = [];
    const seenSig = new Set();
    for (const b of boxes) {
      if (boxes.some((o) => o !== b && b.el.contains(o.el))) continue;
      // Полка рекомендаций не содержит саму карточку: если в контейнере есть
      // ссылка на якорь — это блок товара/страница, а не полка.
      if (b.nms.indexOf(cardNm) >= 0) continue;
      const title = boxTitle(b.el) || clean(b.el.getAttribute("aria-label"));
      if (!titleOk(title)) continue;
      const sig = `${title}|${b.nms.slice(0, 5).join(",")}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      out.push({ title: clamp(title, 120), nms: b.nms });
    }
    return out;
  }

  function assignTitles() {
    if (!cardNm) return false;
    const dom = domShelves();
    if (!dom.length) return false;
    let changed = false;
    for (const s of shelves.values()) {
      if (s.title || !s.items.size) continue;
      const A = new Set(s.items.keys());
      let best = null;
      let bestScore = 0;
      for (const d of dom) {
        const D = new Set(d.nms);
        let inter = 0;
        for (const nm of D) if (A.has(nm)) inter++;
        const score = D.size ? inter / D.size : 0;
        if (score > bestScore) {
          bestScore = score;
          best = d;
        }
      }
      if (best && bestScore >= 0.5 && titleOk(best.title)) {
        s.title = best.title;
        s.title_source = "dom";
        learn(s.preset_id, best.title, bestScore);
        changed = true;
      }
    }
    if (changed) {
      saveDict();
      scheduleSend();
      console.log(
        "[SHELF] DOM-подписи:",
        [...shelves.values()].map((s) => `${s.preset_id}:${s.title || "?"}`).join(" | ")
      );
    }
    return changed;
  }

  function scheduleScan() {
    if (!cardNm) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(assignTitles, SCAN_DELAY);
  }

  // Полки дорисовываются после JSON — ловим скролл и мутации, но не чаще 1 раза в секунду.
  let lastScrollScan = 0;
  if (cardNm) {
    window.addEventListener(
      "scroll",
      () => {
        const now = Date.now();
        if (now - lastScrollScan < 1000) return;
        lastScrollScan = now;
        assignTitles();
      },
      { passive: true }
    );
  }

  // ---------------- отправка ----------------
  // Реальные ссылки на клипы из DOM: WB рисует <a href="https://wibes.ru/clips/<id>">.
  // Нужны, только если ответ api-wibes не принёс поле link.
  function domClipUrls() {
    const map = new Map();
    let nodes;
    try {
      nodes = document.querySelectorAll('a[href*="/clips/"]');
    } catch {
      return map;
    }
    for (const a of nodes) {
      const raw = a.getAttribute("href") || "";
      const m = raw.match(/\/clips\/(\d{4,})/i);
      if (!m) continue;
      let abs;
      try {
        abs = new URL(raw, location.origin).href;
      } catch {
        continue;
      }
      if (!/wibes\.ru|wildberries\.ru/i.test(abs)) continue;
      map.set(parseInt(m[1], 10), abs);
    }
    return map;
  }

  function buildPayload() {
    const list = [];
    for (const s of shelves.values()) {
      if (!s.items.size) continue;
      const items = [...s.items.values()]
        .sort((a, b) => (a.page - b.page) || (a.position - b.position))
        .slice(0, MAX_SHELF_ITEMS)
        .map((it, i) => ({ ...it, position: i + 1 }));
      list.push({
        kind: s.kind,
        route: s.route,
        preset_id: s.preset_id,
        preset_type: s.preset_type,
        title: s.title || "",
        title_source: s.title_source || "none",
        total_candidates: s.total_candidates,
        pages_loaded: s.pages_loaded || 1,
        subject_id: s.subject_id,
        parent_subject_id: s.parent_subject_id,
        imt_id: s.imt_id,
        items,
      });
      if (list.length >= MAX_SHELVES) break;
    }

    const runList = [];
    for (const r of offers.values()) {
      const items = [...r.items.values()].map((it, i) => ({ ...it, position: i + 1 }));
      if (!items.length) continue;
      runList.push({ ...r, items });
    }

    const clipList = [...clips.values()];
    // Реальные ссылки на клипы из DOM (WB рисует <a href="/wibes/...">):
    // надёжнее шаблона, не надо угадывать slug.
    const urlMap = domClipUrls();
    let withUrl = 0;
    for (const c of clipList) {
      if (!c.public_url && urlMap.has(c.clip_id)) c.public_url = urlMap.get(c.clip_id);
      if (c.preview_url && c.preview_url.charAt(0) === "/") {
        try {
          c.preview_url = new URL(c.preview_url, location.origin).href;
        } catch {}
      }
      if (c.public_url) withUrl++;
    }

    return {
      nm_id: cardNm,
      dest: dest || 0,
      spp: spp == null ? null : spp,
      page_url: clamp(location.href, 500),
      shelves: list,
      offers: runList,
      clips: clipList,
    };
  }

  function scheduleSend() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(doSend, SEND_DELAY);
  }

  function doSend() {
    const payload = buildPayload();
    const count = payload.shelves.reduce((n, s) => n + s.items.length, 0);
    if (!payload.shelves.length && !payload.offers.length && !payload.clips.length) return;
    // Подпись/цена могут измениться без изменения числа строк (DOM дорисовался,
    // min_price обновился) — поэтому в отпечаток входят и они.
    const titles = payload.shelves.map((s) => `${s.preset_id}:${s.title}`).join(",");
    const minima = payload.offers.map((o) => `${o.match_id}:${o.min_price}`).join(",");
    const hash = `${payload.shelves.length}|${count}|${payload.offers.length}|${payload.clips.length}|${payload.clips.filter((c) => c.public_url).length}|${titles}|${minima}`;
    if (hash === lastSent) return;
    lastSent = hash;

    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({ type: "WB_SHELVES", data: payload }, (res) => {
        void chrome.runtime.lastError;
        const ok = !!(res && res.ok);
        const status = (res && res.status) || 0;
        const r = (res && res.result) || null;
        const saved = r ? ` | сохранено: полок=${r.shelves} позиций=${r.items} клипов=${r.clips}` : "";
        console.log(
          `[SHELF] → сервер ${status}: полок=${payload.shelves.length} позиций=${count}` +
            ` дубликатов=${payload.offers.length} клипов=${payload.clips.length}` +
            ` (со ссылкой ${payload.clips.filter((c) => c.public_url).length})` +
            (ok ? saved : ` (${(res && res.error) || "не отправлено, в очереди"})`)
        );
        try {
          window.postMessage(
            JSON.stringify({
              type: STATE_MARK,
              data: {
                ok,
                status,
                nm: payload.nm_id,
                shelves: payload.shelves.length,
                items: count,
                offers: payload.offers.length,
                clips: payload.clips.length,
                titles: payload.shelves.map((s) => `${s.preset_id}:${s.title || "?"}`),
              },
            }),
            "*"
          );
        } catch {}
      });
    } catch {}
  }

  // Диагностика без сервера: из консоли devtools
  //   document.dispatchEvent(new Event("WB_SHELF_DUMP_REQ"))
  //   copy(window.__WB_SHELF_DUMP__)
  document.addEventListener(DUMP_REQ, () => {
    try {
      const payload = buildPayload();
      window.postMessage(JSON.stringify({ type: DUMP_MARK, data: payload }), "*");
      console.table(
        payload.shelves.map((s) => ({
          kind: s.kind,
          preset: s.preset_id,
          type: s.preset_type,
          title: s.title,
          src: s.title_source,
          items: s.items.length,
          total: s.total_candidates,
        }))
      );
    } catch {}
  });

  // Периодически добираем подписи (DOM дорисовывается не сразу), 60 секунд.
  if (cardNm) {
    let ticks = 0;
    const tick = setInterval(() => {
      assignTitles();
      if (++ticks >= 20) clearInterval(tick);
    }, 3000);
  }

  window.addEventListener("pagehide", () => {
    saveDict();
    doSend();
  });

  // Уход со страницы/вкладки: не ждём debounce, отправляем сразу.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") doSend();
  });
})();
