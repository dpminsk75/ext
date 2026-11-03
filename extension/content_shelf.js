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
  function shelfKey(kind, presetId, subjectId, parentSubjectId, dest) {
    // У пресетов id достаточно (preset=583182238). У списка продавца
    // (u-card/list) пресета нет — различаем по категории и региону, иначе
    // разные списки на странице слиплись бы в один блок.
    if (kind === "list") {
      return `${kind}|0|${subjectId || 0}|${parentSubjectId || 0}|${dest || 0}`;
    }
    return `${kind}|${presetId || 0}`;
  }

  // Метка момента в формате search_stamp: 20261027_162147.
  function stampNow() {
    const d = new Date();
    const p = (n, w) => String(n).padStart(w || 2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  // Сырой ответ полки — в background отдельным сообщением (background сам
  // отправит его на /api/ext/shelves-raw, и сервер сохранит файл).
  function sendRaw(env) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(
        {
          type: "WB_SHELF_RAW",
          data: {
            nm_id: cardNm || Number(env.nm_id) || 0,
            url: env.url || "",
            kind: env.kind || "recom",
            raw: env.raw,
            stamp: stampNow(),
          },
        },
        () => void chrome.runtime.lastError
      );
    } catch (e) {
      console.warn("[SHELF] сырой ответ не отправлен:", e);
    }
  }

  function onEnvelope(env) {
    if (!env || !env.kind) return;
    if (env.dest) dest = Number(env.dest) || dest;
    if (env.spp != null) spp = Number(env.spp);

    // Полки/дубликаты имеют смысл только на карточке; клипы — на любой странице WB.
    if (!cardNm && env.kind !== "clips") return;

    // Сырой ответ полки карточки — отдельным сообщением в background (он
    // уйдёт на сервер файлом). В общий payload полок он не влезает.
    if ((env.kind === "recom" || env.kind === "list") && env.raw) {
      sendRaw(env);
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
    const key = shelfKey(env.kind, env.preset_id, env.subject_id,
                         env.parent_subject_id, env.dest);
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

  // ---------------- DOM: подписи и фото полок ----------------
  //
  // Разметка WB (проверена на карточке 2026-10-28):
  //   «См. также»            → section.cards-list > .goods-slider__header-wrap,
  //                             карточки в .cards-list__container;
  //   «Продавец рекомендует» → .product-page__seller-rec-new .premium-products__title,
  //                             карточки в карусели рядом.
  // Подпись блока — обычный DIV (не h2-h5), поэтому ищем по классам.
  // Карточка блока: article[data-nm-id] (у «Продавец рекомендует») либо
  // article[data-popup-nm-id] (у «См. также»).
  const BLOCK_TITLE_SELECTORS = [
    ".goods-slider__header-wrap",
    ".premium-products__title",
    ".subscribe-plane__title",
  ];
  const CARD_SELECTOR = "article[data-nm-id], article[data-popup-nm-id]";

  function countCards(el) {
    try {
      return el.querySelectorAll(CARD_SELECTOR).length;
    } catch {
      return 0;
    }
  }

  // Контейнер карточек блока: следующий сосед заголовка (или его родителя),
  // в котором уже есть >= MIN_DOM_NMS карточек.
  function findBlockBox(hdr) {
    let s = hdr.nextElementSibling;
    for (let i = 0; i < 3 && s; i++, s = s.nextElementSibling) {
      if (countCards(s) >= MIN_DOM_NMS) return s;
    }
    const p = hdr.parentElement;
    if (p) {
      s = p.nextElementSibling;
      for (let i = 0; i < 3 && s; i++, s = s.nextElementSibling) {
        if (countCards(s) >= MIN_DOM_NMS) return s;
      }
    }
    return null;
  }

  // Карточки блока из DOM: nm, фото, бейджи, название, рейтинг, отзывы.
  // В ответах WB фото и бейджей нет (проверено на сыром ответе каталога) —
  // берём их здесь, из того, что реально показал WB.
  function domCards(box) {
    const out = [];
    let arts = [];
    try {
      arts = box.querySelectorAll(CARD_SELECTOR);
    } catch {
      arts = [];
    }
    for (const art of arts) {
      let nm = Number(art.getAttribute("data-nm-id") || art.getAttribute("data-popup-nm-id") || 0);
      if (!nm) {
        const a = art.querySelector('a[href*="/catalog/"]');
        nm = a ? nmOf(a) : 0;
      }
      if (!nm) continue;
      const img = art.querySelector("img.j-thumbnail") || art.querySelector("img");
      const image_url = img
        ? String(img.getAttribute("data-src-pb") || img.getAttribute("src") || "")
        : "";
      const badges = [];
      for (const b of art.querySelectorAll("[data-testid='saleBadge'], [data-testid='feedbackBadge']")) {
        const t = clean(b.innerText || b.textContent);
        if (t && badges.indexOf(t) < 0) badges.push(t);
      }
      const text = (sel) => {
        const el = art.querySelector(sel);
        return el ? clean(el.innerText || el.textContent) : "";
      };
      out.push({
        nm_id: nm,
        position: Number(art.getAttribute("data-card-index") || 0) || 0,
        image_url: image_url,
        badges: badges,
        name: text("[data-testid='productName']"),
        price_text: text("[data-testid='product-card-current-price']"),
        rating_text: text("[data-testid='catalogCardRating']"),
        reviews_text: text("[data-testid='catalogCardCommentCount']"),
      });
    }
    return out;
  }

  // Блоки, найденные в DOM: [{el, title, cards, nms}]
  function domShelves() {
    const out = [];
    const seenBox = new Set();
    for (const sel of BLOCK_TITLE_SELECTORS) {
      let heads = [];
      try {
        heads = document.querySelectorAll(sel);
      } catch {
        heads = [];
      }
      for (const hdr of heads) {
        const title = clean(hdr.innerText || hdr.textContent);
        if (!title || title.length > 60) continue;
        const box = findBlockBox(hdr);
        if (!box || seenBox.has(box)) continue;
        seenBox.add(box);
        const cards = domCards(box);
        if (cards.length < MIN_DOM_NMS) continue;
        out.push({ el: box, title, cards, nms: cards.map((c) => c.nm_id) });
      }
    }
    return out;
  }

  // Подпись блока не должна быть названием товара: внутри блока первым
  // заголовком идёт h2 карточки — такие «подписи» попадали в словарь
  // (например «Город Медиа Софт/Дневник садовода…» вместо «Смотрите также»).
  function normText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\w\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isItemName(title, shelf) {
    const t = normText(title);
    if (!t || t.length < 4) return false;
    for (const it of shelf.items.values()) {
      const n = normText(it.name);
      if (!n || n.length < 4) continue;
      if (t === n || t.indexOf(n) >= 0 || n.indexOf(t) >= 0) return true;
    }
    return false;
  }

  // Последний найденный в DOM блок: подпись + карточки + к какому блоку API
  // он подошёл (для файла dom_*.json и для привязки фото/бейджей).
  let domBlocks = [];

  function assignTitles() {
    if (!cardNm) return false;
    const dom = domShelves();
    domBlocks = dom;
    if (!dom.length) return false;
    let changed = false;

    // Фото и бейджи — по nm из ВСЕХ найденных блоков: не зависит от того,
    // удалось ли сопоставить блок с ответом API.
    const byNm = new Map();
    for (const d of dom) {
      for (const c of d.cards) {
        if (!byNm.has(c.nm_id)) byNm.set(c.nm_id, c);
      }
    }
    for (const s of shelves.values()) {
      for (const it of s.items.values()) {
        const c = byNm.get(it.nm_id);
        if (!c) continue;
        if (c.image_url && !it.image_url) {
          it.image_url = c.image_url;
          changed = true;
        }
        if (c.badges && c.badges.length && !(it.badges && it.badges.length)) {
          it.badges = c.badges.slice(0, 6);
          changed = true;
        }
      }
    }

    // Подписи блоков — по совпадению nm с позициями ответа API.
    for (const d of dom) {
      const D = new Set(d.nms);
      let best = null;
      let bestScore = 0;
      for (const s of shelves.values()) {
        if (!s.items.size) continue;
        const A = new Set(s.items.keys());
        let inter = 0;
        for (const nm of D) if (A.has(nm)) inter++;
        const score = D.size ? inter / D.size : 0;
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      d.shelf = best || null;
      d.preset_id = best ? Number(best.preset_id) || 0 : 0;
      d.kind = best ? best.kind : "";
      if (!best || bestScore < 0.5) continue;
      if (best.title) continue;
      if (!titleOk(d.title)) continue;
      if (isItemName(d.title, best)) continue;
      best.title = d.title;
      best.title_source = "dom";
      learn(best.preset_id, d.title, bestScore);
      changed = true;
    }
    if (changed) {
      saveDict();
      scheduleSend();
      console.log(
        "[SHELF] DOM-подписи:",
        [...shelves.values()].map((s) => `${s.kind}:${s.preset_id}:${s.title || "?"}`).join(" | ")
      );
    }
    return changed;
  }

  // Блоки, как мы их увидели в DOM (для файла dom_*.json на сервере).
  function domBlocksPayload() {
    if (!domBlocks.length) {
      // Скан ещё не шёл — запускаем (он же сопоставит блоки с ответами API
      // и проставит kind/preset_id).
      assignTitles();
    }
    return domBlocks.map((d) => ({
      title: d.title || "",
      kind: d.kind || "",
      preset_id: d.preset_id || 0,
      cards: (d.cards || []).map((c) => ({
        nm_id: c.nm_id,
        position: c.position || 0,
        image_url: c.image_url || "",
        badges: c.badges || [],
        name: c.name || "",
        price_text: c.price_text || "",
        rating_text: c.rating_text || "",
        reviews_text: c.reviews_text || "",
      })),
    }));
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

  // content.js (сбор карточки) просит пересканировать DOM и отправить полки
  // СРАЗУ: вкладку закрывает background сразу после отчёта о сборе, а отправка
  // с паузой 1,5 с в неё не успевала — подписи блоков и фото терялись.
  window.addEventListener("wbcm-shelf-scan", () => {
    try {
      assignTitles();
      doSend();
    } catch (e) {
      console.warn("[SHELF] пересказ не удался:", e);
    }
    try {
      window.dispatchEvent(new CustomEvent("wbcm-shelf-scan-done"));
    } catch {}
  });
  try {
    window.__WB_SHELF_READY__ = true;
  } catch {}

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
      stamp: stampNow(),
      // Блоки, как мы их увидели в DOM (сервер сохранит их файлом dom_*.json).
      dom_blocks: domBlocksPayload(),
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
    // DOM-блоки тоже в отпечаток: они меняются (дорисовка карусели), а без них
    // сервер не перезапишет файл dom_*.json.
    const domSig = (payload.dom_blocks || [])
      .map((b) => `${b.title}:${(b.cards || []).length}`)
      .join(",");
    const hash = `${payload.shelves.length}|${count}|${payload.offers.length}|${payload.clips.length}|${payload.clips.filter((c) => c.public_url).length}|${titles}|${minima}|${domSig}`;
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
