// Перехват СОБСТВЕННЫХ ответов WB: поиск + полки/дубликаты/клипы.
// Запускается в MAIN world (world: "MAIN", document_start) — раньше скриптов сайта,
// чтобы перехватить первый же запрос страницы.
//
// Мы НЕ ходим на WB сами: берём ответ, который страница уже получила.
// Никакого дополнительного трафика — только наблюдение.
//
// Каналы:
//   search  -> WB_SEARCH_JSON_V1  (как раньше: /__internal/u-search/exactmatch/?resultset=catalog)
//   shelf   -> WB_SHELF_JSON_V1   (u-recom/v9, u-card/cards/vX/list,
//                                  meta/duplicates/vX, api-wibes/esearch)
// Конверты прокидываются в content_*.js через window.postMessage (JSON-строка)
// и через CustomEvent на document (запасной канал).
(() => {
  const SEARCH_MARK = "WB_SEARCH_JSON_V1";
  const SHELF_MARK = "WB_SHELF_JSON_V1";
  const STATE_MARK = "WB_SHELF_SENT_V1";
  const DUMP_MARK = "WB_SHELF_DUMP_V1";
  const HOOK_VER = "1.18";
  const MAX_LOG = 30;

  // Диагностика для консоли (MAIN world — видно из devtools без переключения контекста).
  const log = [];
  const recent = []; // последние конверты: content_shelf может стартовать позже первого запроса
  try {
    window.__WB_SHELF_LOG__ = log;
    window.__WB_SHELF_SENT__ = [];
    window.__WB_SHELF_DUMP__ = null;
    window.__WB_API_ALL__ = [];
    window.__WB_CLIPDBG__ = [];
    window.__WB_CLIPRAW__ = null;
  } catch {}

  // Только выдача каталога: /__internal/u-search/exactmatch/ru/common/v18/search?resultset=catalog
  function isCatalog(url) {
    const s = String(url || "");
    if (!/\/__internal\/u-search\/exactmatch\//i.test(s)) return false;
    return /[?&]resultset=catalog(&|$)/i.test(s);
  }

  // ⚠️ u-recom тоже приходит с resultset=catalog — поэтому classify проверяет
  // u-search ПЕРВЫМ и только потом остальные пути (иначе поиск сломается).
  // Привязки к /__internal/ нет: часть запросов WB уходит на другие хосты
  // (u-content и т.п.), но путь узнаваем.
  function classify(url) {
    const s = String(url || "");
    if (!s) return null;
    if (isCatalog(s)) return { ch: "search" };
    if (/\/u-recom\/recom\/.*?\/v\d+\/search/i.test(s)) return { ch: "shelf", kind: "recom" };
    if (/\/u-card\/cards\/v\d+\/list/i.test(s)) return { ch: "shelf", kind: "list" };
    if (/\/meta\/duplicates\/.*?\/v\d+\/search/i.test(s)) return { ch: "shelf", kind: "duplicates" };
    // клипы: /api-wibes/esearch/v2/nms, но версия/путь могут отличаться
    if (/api-wibes/i.test(s) || /\/wibes\/.*\/(nms|clips|feed)/i.test(s)) return { ch: "shelf", kind: "clips" };
    return null;
  }

  // Диагностика «а какие вообще внутренние ручки дергает карточка».
  // Без неё нельзя понять, почему клипы не пришли: не было запроса или не тот URL.
  function recordApi(url, data) {
    try {
      const s = String(url || "");
      if (!/internal|api-wibes|u-recom|u-card|u-search|wibes/i.test(s)) return;
      const path = s.split("?")[0].slice(0, 300);
      const arr = window.__WB_API_ALL__ || (window.__WB_API_ALL__ = []);
      if (arr.length >= 80) return;
      if (arr.some((x) => x.path === path)) return;
      let keys = [];
      let count = 0;
      if (Array.isArray(data)) {
        keys = ["<array>"];
        count = data.length;
      } else if (data && typeof data === "object") {
        keys = Object.keys(data).slice(0, 14);
        const a = data.products || data.clips || data.items || data.nms;
        count = (Array.isArray(a) ? a.length : 0) || Number(data.total || data.count || 0) || 0;
      }
      arr.push({ path, keys, count });
    } catch {}
  }

  function qs(url) {
    const out = {};
    try {
      const u = new URL(String(url), location.href);
      u.searchParams.forEach((v, k) => {
        out[k] = v;
      });
    } catch {}
    return out;
  }

  // null вместо 0: 0 — валидное значение (matchId: 0), но "нет поля" ≠ 0.
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function kop(v) {
    const n = num(v);
    return n === null ? null : Math.round(n / 100);
  }

  // ---------- поиск (как было) ----------
  function compact(data) {
    const list = (data && data.products) || [];
    const out = [];
    for (const p of list) {
      if (!p || !p.id) continue;
      const sz = (p.sizes && p.sizes[0]) || {};
      const pr = sz.price || {};
      out.push({
        id: p.id,
        name: p.name || "",
        brand: p.brand || "",
        supplier: p.supplier || "",
        supplier_rating: Number(p.supplierRating) || 0,
        rating: Number(p.reviewRating) || Number(p.rating) || 0,
        reviews: Number(p.feedbacks) || 0,
        promo_id: Number(p.panelPromoId) || 0,
        is_new: !!p.isNew,
        // цены WB в копейках: product — после скидки продавца, basic — до скидки
        price_u: Number(pr.product) || 0,
        old_price_u: Number(pr.basic) || 0,
      });
    }
    return out;
  }

  function emitSearch(data) {
    let items;
    try {
      items = compact(data);
    } catch {
      return;
    }
    if (!items.length) return;
    send(SEARCH_MARK, { type: SEARCH_MARK, items });
  }

  // ---------- полки / дубликаты ----------
  // Поля — из плана 2026-10-22 (§2.3, §4.2, §5.2). Цены уже в рублях:
  // в базе цены INT-рубли, деление на 100 делаем здесь, на границе.
  function normProduct(p) {
    if (!p || !p.id) return null;
    const sz = (p.sizes && p.sizes[0]) || {};
    const pr = sz.price || p.price || {};
    const meta = p.meta || {};
    return {
      nm_id: Number(p.id) || 0,
      name: String(p.name || "").slice(0, 500),
      brand: String(p.brand || "").slice(0, 255),
      brand_id: num(p.brandId),
      seller_id: num(p.supplierId),
      seller: String(p.supplier || "").slice(0, 255),
      seller_rating: num(p.supplierRating),
      subject_id: num(p.subjectId),
      root_id: num(p.root),
      match_id: num(p.matchId) || null,
      rating: num(p.rating),
      review_rating: num(p.reviewRating),
      feedbacks: num(p.feedbacks),
      feedback_points: num(p.feedbackPoints),
      total_qty: num(p.totalQuantity),
      price: kop(pr.product),
      price_basic: kop(pr.basic),
      cashback: num(pr.cashback),
      time1: num(p.time1),
      time2: num(p.time2),
      wh: num(p.wh),
      dist: num(p.dist),
      volume: num(p.volume),
      weight: num(p.weight),
      pics: num(p.pics),
      pics_update: num(p.picsUpdate),
      option_id: num(sz.optionId),
      is_new: p.isNew ? 1 : 0,
      promo_panel_id: num(p.panelPromoId),
      preset_type: String(meta.preset_type || p.preset_type || "").slice(0, 32),
      semantic_id: Array.isArray(p.semanticId) ? p.semanticId : null,
      sale_conditions: num(p.saleConditions),
      dtype_mask: num(p.dtypeMask),
      sort_score: num(p.__sort) !== null ? num(p.__sort) : num(p.sort),
    };
  }

  function normClip(c) {
    if (!c || typeof c !== "object") return null;
    const clipId = num(c.id) || num(c.clip_id) || num(c.clipId);
    if (!clipId) return null;
    const a = c.author || c.user || {};
    let rawNms = c.nms || c.nmIds || c.nm_ids || c.nmIdsList || [];
    if (Array.isArray(rawNms) && rawNms.length && !Array.isArray(rawNms[0])) rawNms = [rawNms];
    const nms = Array.isArray(rawNms)
      ? rawNms.filter(Array.isArray).map((g) => g.map((x) => (typeof x === "object" ? num(x.nmId || x.id) : num(x)) || 0).filter(Boolean))
      : [];

    // Ссылки: WB отдаёт их под разными именами, а иногда не отдаёт вовсе.
    const pickUrl = (...vals) => {
      for (const v of vals) {
        if (typeof v === "string" && /^https?:\/\//i.test(v)) return v.slice(0, 512);
      }
      return "";
    };
    const public_url = pickUrl(
      c.public_url, c.url, c.link, c.web_url, c.webUrl, c.share_url, c.shareUrl,
      c.short_url, c.shortUrl, c.permalink
    );
    const video_url = pickUrl(
      c.video_url, c.videoUrl, c.hls, c.hls_url, c.video_hls, c.videoHls, c.mp4, c.video
    );

    // Всё незнакомое — в extra, чтобы не терять поля ответа (URL, флаги, счётчики).
    const KNOWN = new Set([
      "id", "clip_id", "clipId", "type", "slug", "name", "title", "description",
      "preview_url", "previewUrl", "preview", "poster", "cover", "image", "thumbnail",
      "video_duration_s", "duration_s", "publication_date", "publicationDate", "author", "user",
      "nms", "nmIds", "nm_ids", "nmIdsList", "public_url", "url", "link", "web_url", "webUrl",
      "share_url", "shareUrl", "short_url", "shortUrl", "permalink",
      "video_url", "videoUrl", "hls", "hls_url", "video_hls", "videoHls", "mp4", "video",
    ]);
    const extra = {};
    let nExtra = 0;
    for (const k of Object.keys(c)) {
      if (KNOWN.has(k) || nExtra >= 30) continue;
      if (/^video_hls/i.test(k)) continue; // тяжёлые плейлисты не храним
      const v = c[k];
      if (v === null || v === undefined) continue;
      extra[k] = typeof v === "object" ? JSON.stringify(v).slice(0, 300) : String(v).slice(0, 300);
      nExtra++;
    }

    return {
      clip_id: clipId,
      type: String(c.type || "video").slice(0, 16),
      slug: String(c.slug || "").slice(0, 255),
      name: String(c.name || c.title || "").slice(0, 255),
      description: String(c.description || "").slice(0, 2000),
      preview_url: String(c.preview_url || c.previewUrl || c.preview || c.poster || c.cover || c.image || "").slice(0, 512),
      public_url,
      video_url,
      duration_s: num(c.video_duration_s) || num(c.duration_s),
      publication_date: c.publication_date || c.publicationDate || null,
      author_id: num(a.id),
      author_slug: String(a.slug || "").slice(0, 255),
      author_name: String(a.name || a.nickname || "").slice(0, 255),
      author_verified: a.is_verified || a.isVerified ? 1 : 0,
      author_code: num(a.code),
      // Автор целиком: ссылка на профиль, аватар, описание, флаги.
      author: a && typeof a === "object" && Object.keys(a).length
        ? {
            id: num(a.id),
            slug: String(a.slug || "").slice(0, 255),
            name: String(a.name || a.nickname || "").slice(0, 255),
            link: String(a.link || "").slice(0, 512),
            description: String(a.description || "").slice(0, 1000),
            avatar_link: String(a.avatar_link || a.avatarLink || "").slice(0, 512),
            is_verified: a.is_verified || a.isVerified ? 1 : 0,
            is_community_verified: a.is_community_verified ? 1 : 0,
            is_slug_custom: a.is_slug_custom ? 1 : 0,
          }
        : null,
      nms,
      extra,
    };
  }

  // Ответы клипов приходят в разных обёртках: {clips}, {data:{clips}}, массив и т.п.
  function pickList(data, keys) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
    for (const wrap of ["data", "result", "payload", "response"]) {
      const v = data[wrap];
      if (v && typeof v === "object") {
        for (const k of keys) {
          if (Array.isArray(v[k])) return v[k];
        }
      }
    }
    return [];
  }

  function presetFromCatalogValue(v) {
    const m = String(v || "").match(/preset=(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function emitShelf(kind, url, data) {
    const params = qs(url);
    const page = num(params.page) || 1;
    const md = (data && data.metadata) || {};
    const sr = md.SearchResult || {};
    const minItem = md.min_price_item || null;

    const env = {
      type: SHELF_MARK,
      kind,
      route: "",
      url: String(url || "").slice(0, 2000),
      page,
      nm_id: num(params.nmId) || num(params.anchor_id) || 0,
      preset_id: 0,
      preset_type: "",
      subject_id: num(params.sbjId),
      parent_subject_id: num(params.pSbjId),
      imt_id: num(params.imt_id),
      dest: num(params.dest) || 0,
      spp: num(params.spp),
      match_id: num(params.match_id),
      anchor_supplier_id: num(params.anchor_supplier_id),
      meta: {
        total: num(data && data.total),
        catalog_type: String(md.catalog_type || ""),
        catalog_value: String(md.catalog_value || ""),
        shard_key: String(sr.ShardKey || ""),
        shard_query: String(sr.ShardQuery || ""),
        response_type: String(sr.ResponseType || ""),
        benefit: String(md.benefit || ""),
        min_price: kop(md.minimal_price),
        min_price_nm_id: num(minItem && minItem.id),
        pagination_total: num(data && data.pagination && data.pagination.total),
      },
      items: [],
      clips: [],
    };

    try {
      if (kind === "clips") {
        env.route = "api-wibes/v2";
        const list = pickList(data, ["clips", "items", "products", "videos", "results"]);
        env.clips = list.map(normClip).filter(Boolean);
        // Диагностика: даже если не распознали — видно, что пришло и в какой обёртке.
        try {
          const dbg = window.__WB_CLIPDBG__ || (window.__WB_CLIPDBG__ = []);
          dbg.push({
            at: new Date().toISOString(),
            url: String(url || "").split("?")[0],
            keys: data && typeof data === "object" ? Object.keys(data).slice(0, 14) : [],
            raw: list.length,
            parsed: env.clips.length,
          });
          if (dbg.length > 20) dbg.shift();
          window.__WB_CLIPRAW__ = data;
        } catch {}
        if (!env.clips.length) return;
      } else {
        env.route = kind === "recom" ? "u-recom/v9" : kind === "list" ? "v4/list" : "v8/duplicates";
        const list = pickList(data, ["products", "items", "cards"]);
        const items = [];
        for (let i = 0; i < list.length; i++) {
          const it = normProduct(list[i]);
          if (!it) continue;
          it.page = page;
          it.position = i + 1;
          items.push(it);
        }
        if (!items.length) return;
        env.items = items;
        env.preset_id = presetFromCatalogValue(md.catalog_value) || presetFromCatalogValue(sr.ShardQuery);
        env.preset_type = String((items[0] && items[0].preset_type) || "");
        if (!env.preset_id) {
          const pid = list[0] && list[0].meta && list[0].meta.presetId;
          env.preset_id = num(pid) || 0;
        }
      }
    } catch {
      return;
    }

    pushLog(env);
    recent.push(env);
    if (recent.length > 10) recent.shift();
    send(SHELF_MARK, env);
  }

  function pushLog(env) {
    try {
      log.push({
        at: new Date().toISOString(),
        kind: env.kind,
        nm: env.nm_id,
        preset: env.preset_id,
        page: env.page,
        items: env.items.length,
        clips: env.clips.length,
        total: env.meta.total,
      });
      if (log.length > MAX_LOG) log.shift();
      window.__WB_SHELF_LAST__ = env;
      console.log(
        `[WB-SHELF] ${env.kind} nm=${env.nm_id} preset=${env.preset_id}` +
          ` page=${env.page} items=${env.items.length || env.clips.length}` +
          ` total=${env.meta.total ?? "-"}`
      );
    } catch {}
  }

  function send(mark, obj) {
    let payload;
    try {
      payload = JSON.stringify(obj);
    } catch {
      return;
    }
    try {
      window.postMessage(payload, "*");
    } catch {}
    try {
      document.dispatchEvent(new CustomEvent(mark, { detail: payload }));
    } catch {}
  }

  function handle(url, data) {
    recordApi(url, data);
    const c = classify(url);
    if (!c) {
      // Незнакомый внутренний путь — в копилку: вдруг это новая полка/версия API.
      try {
        const s = String(url || "");
        if (/\/__internal\//i.test(s) && !/\/u-search\//i.test(s)) {
          const path = s.split("?")[0];
          const arr = window.__WB_UNMATCHED__ || (window.__WB_UNMATCHED__ = []);
          if (arr.length < 20 && arr.indexOf(path) < 0) arr.push(path);
        }
      } catch {}
      return;
    }
    if (c.ch === "search") emitSearch(data);
    else emitShelf(c.kind, url, data);
  }

  // content_shelf.js присылает сюда сводку «что реально ушло на сервер»,
  // чтобы её было видно из консоли MAIN world.
  try {
    window.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      if (ev.data.indexOf(DUMP_MARK) >= 0) {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === DUMP_MARK) window.__WB_SHELF_DUMP__ = msg.data || null;
        } catch {}
        return;
      }
      if (ev.data.indexOf(STATE_MARK) < 0) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === STATE_MARK) {
          const arr = window.__WB_SHELF_SENT__ || [];
          arr.push({ at: new Date().toISOString(), ...(msg.data || {}) });
          if (arr.length > MAX_LOG) arr.shift();
          window.__WB_SHELF_SENT__ = arr;
        }
      } catch {}
    });
  } catch {}

  // content_shelf.js стартует на document_idle и может не успеть подписаться
  // на первый ответ страницы. По запросу отдаём последние конверты заново.
  const replay = () => {
    for (const env of recent) {
      try {
        send(SHELF_MARK, env);
      } catch {}
    }
  };
  try {
    window.__WB_SHELF_REPLAY__ = replay;
    document.addEventListener("WB_SHELF_REPLAY_REQ", replay);
  } catch {}

  try {
    console.log(`[WB-HOOK] v${HOOK_VER} channels: search+shelf`);
  } catch {}

  // --- fetch ---
  try {
    const orig = window.fetch;
    if (typeof orig === "function" && !orig.__wbHooked) {
      const patched = function (...args) {
        const p = orig.apply(this, args);
        try {
          const u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          if (classify(u)) {
            // clone делаем ДО того, как страница прочитает тело ответа
            p.then((r) => {
              try {
                return r.clone();
              } catch {
                return null;
              }
            })
              .then((c) => (c ? c.json().then((d) => handle(u, d)).catch(() => {}) : null))
              .catch(() => {});
          }
        } catch {}
        return p;
      };
      patched.__wbHooked = true;
      window.fetch = patched;
    }
  } catch {}

  // --- XHR ---
  try {
    const XHR = window.XMLHttpRequest;
    const open = XHR.prototype.open;
    const sendXhr = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__wbUrl = String(url || "");
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        if (classify(this.__wbUrl)) {
          this.addEventListener("load", () => {
            try {
              let txt = "";
              if (this.responseType === "" || this.responseType === "text") txt = this.responseText;
              else if (this.responseType === "json") txt = JSON.stringify(this.response);
              if (txt) handle(this.__wbUrl, JSON.parse(txt));
            } catch {}
          });
        }
      } catch {}
      return sendXhr.apply(this, arguments);
    };
  } catch {}
})();
