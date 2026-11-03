(() => {
  // Страница поиска? WB меняет адреса: /catalog/0/search.aspx?search=…, /search/?query=…
  function pathIsSearch() {
    const p = location.pathname;
    return /^\/search\//i.test(p) || /^\/catalog\/0\/search/i.test(p) || /\/search(\.aspx)?$/i.test(p);
  }
  // Контейнер выдачи — чтобы не среагировать на «похожие товары» на карточке
  function domIsSearch() {
    return !!document.querySelector(".product-card-list");
  }

  // Автосбор возможен только на странице выдачи. Карточка товара исключается,
  // даже если в блоках рекомендаций есть .product-card-list: «похожие товары»
  // карточки фонового сбора не должны записываться как результат поиска.
  function searchPage() {
    return pathIsSearch() || (domIsSearch() && !isProductPage());
  }

  // Фраза: из URL (WB — SPA: адрес меняется без перезагрузки), иначе из поля поиска.
  function pickPhrase() {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get("search") || u.searchParams.get("query") || "";
      if (q) return q.trim();
      // Фразу из поля поиска берём только вне карточки товара: там поле шапки
      // хранит старый запрос, и мы бы записали чужую фразу поверх выдачи,
      // собранной с карточки фонового сбора.
      if (isProductPage()) return "";
      if (!pathIsSearch() && !domIsSearch()) return "";
      const inp = document.querySelector(
        '#search-field, input[name="search"], input[type="search"], .search__input, .search-field input'
      );
      return ((inp && inp.value) || "").trim();
    } catch {
      return "";
    }
  }

  console.log(`[SEARCH] start url=${location.pathname}${location.search}`);
  let phrase = pickPhrase();

  function captchaReason() {
    try {
      if (location.href.toLowerCase().includes("captcha")) return "captcha-url";
      const t = (document.body && document.body.innerText || "").toLowerCase();
      if (t.includes("подозрительная активность")) return "wb-captcha";
      if (t.includes("подтвердите, что вы не робот")) return "wb-captcha";
      if (t.includes("вы не робот")) return "wb-captcha";
      if (t.includes("доступ ограничен")) return "wb-captcha";
      if (t.includes("слишком много запросов")) return "wb-captcha";
      if (t.includes("что-то не так") && (t.includes("робот") || t.includes("капча"))) return "wb-captcha";
    } catch {}
    return "";
  }

  // «180 ₽» / «1 490 ₽» (там &nbsp;) → 180 / 1490
  function parseRub(txt) {
    const s = String(txt || "");
    const m = s.match(/\d[\d\s ]*/);
    if (!m) return 0;
    const n = parseInt(m[0].replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }
  function parseNum(txt) {
    const s = String(txt || "").replace(/\s| /g, "").replace(",", ".");
    const m = s.match(/\d+(\.\d+)?/);
    if (!m) return 0;
    const n = parseFloat(m[0]);
    return Number.isFinite(n) ? n : 0;
  }
  function txt(el) {
    return ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  }
  function normPhrase(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  function queryParam(url, name) {
    try {
      return new URL(String(url || ""), location.href).searchParams.get(name) || "";
    } catch {
      return "";
    }
  }

  // Картинка карточки выдачи: классы WB меняются и миниатюры грузятся лениво,
  // поэтому идём по ВСЕМ img внутри карточки (src/currentSrc/srcset/
  // data-srcset/data-src*/data-original) и по background-image. Приоритет —
  // ссылка с маркером `/<nm>/images/` (картинка именно этого товара, а не
  // рекламы/полки); фолбэк — любой WB-фотохост.
  function cardImage(card, nmId) {
    const marker = `/${nmId}/images/`;
    let best = "";
    let any = "";
    const push = (raw) => {
      let s = String(raw || "").trim();
      if (!s || s.startsWith("data:")) return;
      s = s.split(/[\s,]+/)[0].split("?")[0].split("#")[0];
      if (s.startsWith("//")) s = "https:" + s;
      if (!/^https:/i.test(s)) return;
      const low = s.toLowerCase();
      if (!best && low.includes(marker)) best = s;
      if (!any && (low.includes("/images/") || low.includes("wbbasket"))) any = s;
    };
    const pushSrcset = (v) => {
      for (const part of String(v || "").split(",")) push(part.trim().split(/\s+/)[0]);
    };
    for (const img of card.querySelectorAll("img")) {
      push(img.currentSrc || img.src);
      pushSrcset(img.getAttribute("srcset"));
      pushSrcset(img.getAttribute("data-srcset"));
      for (const a of ["data-src", "data-src-pb", "data-original", "data-lazy-src"]) {
        push(img.getAttribute(a));
      }
    }
    if (!best && !any) {
      // миниатюры бывают и div-ами с фоном (inline style от ленивого рендера)
      for (const el of card.querySelectorAll("[style*=background]")) {
        const m = /url\(["']?([^"')]+)["']?\)/i.exec(el.style.backgroundImage || "");
        if (m) push(m[1]);
        if (best || any) break;
      }
    }
    return best || any || "";
  }

  // Бейджи акций/промо: что нашли — складываем в массив строк
  const BADGE_IDS = ["saleBadge", "promoBadge", "goodPriceBadge", "cashbackBadge"];

  // ==========================================================================
  // JSON-выдача WB (перехват hook_wb_api.js)
  //   search-канал: items (разобранные) + raw (ответ как пришёл)
  //   raw-канал:    filters / shelfs / suggest — сырые ответы
  // ==========================================================================
  const SEARCH_MARK = "WB_SEARCH_JSON_V1";
  const RAW_MARK = "WB_SEARCH_RAW_V1";
  const apiById = new Map();

  // Метка выдачи: своя на каждую фразу (фраза+время). Файлы разных запросов
  // не затирают друг друга, а повторный приход того же вида перезаписывает свой файл.
  const stamps = {}; // норм. фраза -> метка
  let rawParts = {}; // kind -> {url, raw, phrase, stamp}
  let sentSig = {}; // kind -> сигнатура отправленного содержимого

  function stampNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function stampFor(ph) {
    const key = normPhrase(ph);
    if (!key) return stampNow();
    if (!stamps[key]) stamps[key] = stampNow();
    return stamps[key];
  }
  function ensureStamp() {
    return stampFor(phrase);
  }

  // Новый поиск (сменилась фраза) — сбрасываем то, что относится к предыдущему:
  // разобранные товары прошлой выдачи и счётчики. Накопленные сырые ответы НЕ
  // трогаем: каждый из них привязан к своей фразе (query= в его URL).
  function resetForNewSearch() {
    apiById.clear();
    priceCheck = { dom: 0, eqProduct: 0, eqBasic: 0, other: 0, pct: [], samples: [] };
    lastSkipped = 0;
    attempts = 0;
    collectedPhrase = "";
    sent = false;
    imgStable = { t0: 0, last: -1 };
    lastSentEmpty = -1;
    imgRetryLeft = 0;
    setUI("", "Собрать выдачу", "выдача → позиции, цены, бейджи");
  }

  // Переключаемся на фразу, к которой относится ответ WB (query= в его URL).
  // Переключение только по каталогу (он приходит в порядке), чтобы не скакать
  // назад на поздний ответ.
  function switchContext(q) {
    const np = normPhrase(q);
    if (!np || np === normPhrase(phrase)) return false;
    phrase = String(q).trim();
    resetForNewSearch();
    console.log(`[SEARCH] смена поиска → "${phrase}"`);
    return true;
  }

  // Сигнатура содержимого: отправляем вид, только если он изменился.
  function sigOf(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `${s.length}:${h}`;
  }

  let rawTimer = null;
  function scheduleRawSend(delay = 200) {
    if (rawTimer) clearTimeout(rawTimer);
    rawTimer = setTimeout(flushRaw, delay);
  }

  // Каждый вид — отдельным POST: потеря большого каталога не должна утаскивать
  // за собой подсказки/фильтры. Вид уходит со своей фразой и своей меткой.
  async function flushRaw() {
    rawTimer = null;
    for (const kind of Object.keys(rawParts)) {
      const part = rawParts[kind];
      const key = `${kind}|${normPhrase(part.phrase)}`;
      const sig = sigOf(part.raw || "");
      if (sentSig[key] === sig) continue;
      const res = await postRaw(kind, part);
      if (res && res.ok) {
        sentSig[key] = sig;
        const files = (res.result && res.result.files) || [];
        console.log(
          `[SEARCH] сырое ${kind} («${part.phrase}»): сохранено · файлов ${files.length} · ${JSON.stringify(files)}`
        );
      } else {
        console.warn(
          `[SEARCH] сырое ${kind} («${part.phrase}»): НЕ сохранено · статус ${(res && res.status) || 0}` +
            ` · ${(res && res.error) || "нет ответа"}` +
            `${res && res.queued ? " (в очереди)" : ""}`
        );
      }
    }
    refreshFilesUI();
  }

  // Обновляем индикатор, когда доехали файлы (они могут прийти позже DOM-части).
  function refreshFilesUI() {
    const st = loadState();
    if (!st) return;
    let files = 0;
    let total = 0;
    for (const kind of Object.keys(rawParts)) {
      const part = rawParts[kind];
      total++;
      const key = `${kind}|${normPhrase(part.phrase)}`;
      if (sentSig[key] === sigOf(part.raw || "")) files++;
    }
    st.files = files;
    st.ok = !!(st.saved && total > 0 && files === total);
    if (st.ok) st.error = "";
    saveState(st);
    renderUI();
  }

  function postRaw(kind, part) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "WB_SEARCH_RAW",
            data: {
              phrase: part.phrase || phrase,
              search_stamp: part.stamp || stampFor(phrase),
              raw: { [kind]: { url: part.url, raw: part.raw } },
            },
          },
          (res) => {
            void chrome.runtime.lastError;
            resolve(res || { ok: false, error: "нет ответа" });
          }
        );
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function onSearchEnvelope(env) {
    if (!env) return;
    // Действуем только на странице выдачи: на карточке фонового сбора
    // перехваченные ответы WB (похожие товары) чужие для поиска.
    if (!searchPage()) return;
    // Фраза — из URL самого ответа WB: так мы не пропускаем и не путаем запросы.
    const switched = switchContext(env.query || "");
    let added = 0;
    if (Array.isArray(env.items)) {
      for (const it of env.items) {
        const id = Number(it && it.id) || 0;
        if (!id) continue;
        if (!apiById.has(id)) added++;
        apiById.set(id, it);
      }
    }
    if (env.raw) {
      const ph = env.query || phrase;
      rawParts.catalog = { url: env.url || "", raw: env.raw, phrase: ph, stamp: stampFor(ph) };
      scheduleRawSend(150);
    }
    // Выдача догрузилась (WB подгрузил ещё товаров) → обновляем и DOM-отчёт.
    // Во время скролл-досбора картинок не пересылаем: финальный апдейт
    // scrollCollect отправит сам.
    if (added && sent && !scrollRunning) scheduleResend();
    // Ответ пришёл для новой фразы → дособираем её.
    if (switched) scheduleCollect(500);
  }

  function onRawEnvelope(env) {
    if (!env || !env.kind || !env.raw) return;
    if (!searchPage()) return;   // сырые ответы вне выдачи (карточка) — не для поиска
    // Каждый ответ WB сам знает свою фразу (query= в его URL) — привязываем к ней,
    // контекст страницы не трогаем: так ничего не теряется и ничего не путается.
    const ph = String(env.query || "").trim() || phrase;
    if (env.kind === "suggest") {
      // Подсказки сохраняем только по полной фразе текущего поиска,
      // а не по префиксу, который человек набирал.
      if (normPhrase(ph) !== normPhrase(phrase)) return;
    }
    rawParts[env.kind] = { url: env.url || "", raw: env.raw, phrase: ph, stamp: stampFor(ph) };
    scheduleRawSend(400);
  }

  function onMessage(raw) {
    if (typeof raw !== "string") return;
    if (raw.indexOf(SEARCH_MARK) >= 0) {
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg && msg.type === SEARCH_MARK) onSearchEnvelope(msg);
      return;
    }
    if (raw.indexOf(RAW_MARK) >= 0) {
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg && msg.type === RAW_MARK) onRawEnvelope(msg);
    }
  }

  window.addEventListener("message", (ev) => onMessage(ev.data));
  document.addEventListener(SEARCH_MARK, (ev) => onMessage(ev && ev.detail));
  document.addEventListener(RAW_MARK, (ev) => onMessage(ev && ev.detail));
  // Хук мог поймать ответы раньше нашего старта — просим повторить последние конверты.
  try {
    document.dispatchEvent(new Event("WB_SHELF_REPLAY_REQ"));
  } catch {}

  // Сверка цены DOM vs WB API (диагностика): расхождение ~3 % — это кошелёк WB.
  let priceCheck = { dom: 0, eqProduct: 0, eqBasic: 0, other: 0, pct: [], samples: [] };
  let lastSkipped = 0; // сколько карточек DOM не попали в каталог JSON (реклама/полки)

  // Блоки «ничего не найдено» и рекомендаций — НЕ выдача. Их карточки не должны
  // попадать в позиции: на пустой выдаче WB рисует карусель «Хит продаж» с
  // data-nm-id/data-card-index — без этой проверки она собиралась как выдача.
  const NOT_MAIN_LIST =
    ".content404, .content404__recommend, .goods-slider, .custom-slider, [class*='recommendationsCarousel']";
  function inNotMainList(el) {
    try {
      return !!el.closest(NOT_MAIN_LIST);
    } catch {
      return false;
    }
  }

  // Карточки ТОЛЬКО основной выдачи: на странице поиска WB есть ещё брендовые
  // полки и блоки («похожие», «смотрели раньше») — их data-card-index = 0, и
  // в каталоге JSON их нет. Такие строки не пишем.
  function mainListCards() {
    const root = document.querySelector(".product-card-list");
    const sel = "article.product-card, [data-nm-id]";
    if (root) {
      // Есть основной список — берём только его (как раньше).
      return Array.from(root.querySelectorAll(sel)).filter((el) =>
        el.hasAttribute("data-card-index")
      );
    }
    // Списка выдачи нет (пустая выдача / страница «ничего не найдено»):
    // в документе остаются карусели рекомендаций — их карточки выдачей не являются.
    return Array.from(document.querySelectorAll(sel)).filter(
      (el) => el.hasAttribute("data-card-index") && !inNotMainList(el)
    );
  }

  // WB: «По Вашему запросу ничего не найдено» — по этому запросу товаров нет.
  function isEmptyResult() {
    try {
      // 1) Блок пустой выдачи (страховка). Скрытый шаблон WB (есть в DOM каждой
      //    страницы) не считаем — блок должен быть видимым.
      const blk = document.querySelector(".content404");
      if (blk) {
        const rects = blk.getClientRects();
        const bt = (blk.textContent || "").replace(/\u00a0/g, " ").toLowerCase();
        if (rects && rects.length && /ничего не найдено|не нашлось подходящих/.test(bt)) return true;
      }
      // 2) Заголовок пустой выдачи (старая/новая вёрстка WB).
      const head = document.querySelector(
        ".content404__title, [class*='content404'] h1, [class*='not-found'] h1, [class*='notFound'] h1"
      );
      if (head && /ничего не найдено|не нашлось подходящих/i.test(head.textContent || "")) return true;
      // 3) Старый текст WB (может быть без блока .content404).
      const t = ((document.body && document.body.textContent) || "")
        .replace(/\u00a0/g, " ")
        .toLowerCase();
      return t.includes("не нашлось подходящих товаров");
    } catch {
      return false;
    }
  }

  function extract() {
    const cards = mainListCards();
    const products = [];
    let skipped = 0;
    for (const card of cards) {
      const nmId = parseInt(card.getAttribute("data-nm-id"), 10);
      if (!nmId) continue;

      // позиция: WB отдаёт data-card-index с нуля
      const idx = parseInt(card.getAttribute("data-card-index"), 10);
      const position = Number.isFinite(idx) ? idx + 1 : products.length + 1;

      const link = card.querySelector('a[data-testid="product-card-link"]');
      const nameEl = card.querySelector('[data-testid="productName"]');
      const brandEl = card.querySelector('[data-testid="productBrand"]');
      const api = apiById.get(nmId) || null;

      // Каталог JSON пришёл → оставляем только его товары: остальное в DOM —
      // реклама или полки (в JSON их нет), и их позиция/цена — чужие.
      if (apiById.size && !api) {
        skipped++;
        continue;
      }

      const name = txt(nameEl) || txt(link) || (link && link.getAttribute("aria-label")) || (api && api.name) || "";
      const brand = txt(brandEl) || (api && api.brand) || "";

      // цены: актуальная (ins), зачёркнутая (del), «для бизнеса»
      const priceIns = card.querySelector('ins[data-testid="product-card-current-price"]');
      const priceDel = card.querySelector("del");
      const domPrice = parseRub(txt(priceIns));
      const domOld = parseRub(txt(priceDel));
      const bizPrice = parseRub(txt(card.querySelector(".priceExcludeVat--JNKAw")));

      // цены WB API (копейки → рубли) — запасной источник, если DOM не отрисовался
      const apiPrice = api && api.price_u ? Math.round(api.price_u / 100) : 0;
      const apiOld = api && api.old_price_u ? Math.round(api.old_price_u / 100) : 0;

      // «Нет в наличии»: у распроданной карточки в priceBlock PLACEHOLDER h2
      // («Нет в наличии») вместо цены. Цену тогда не пишем — включая запасную
      // из WB API (стоимость там есть, но покупателю её не показывают).
      const soldOut = (() => {
        const h2 = card.querySelector('[class*="soldOutProduct"]');
        if (h2) {
          const t = txt(h2).replace(/\u00a0/g, " ").toLowerCase();
          if (/нет\s+в\s+наличии/.test(t)) return true;
        }
        const pb = card.querySelector('[class*="priceBlock"]');
        return !!(pb && /нет\s+в\s+наличии/i.test((pb.textContent || "").replace(/\u00a0/g, " ")));
      })();
      const price = soldOut ? 0 : (domPrice || apiPrice);
      const oldPrice = soldOut ? 0 : (domOld || apiOld);

      if (api && domPrice && priceCheck.dom < 400) {
        priceCheck.dom++;
        if (domPrice === apiPrice) priceCheck.eqProduct++;
        else if (domPrice === apiOld) priceCheck.eqBasic++;
        else {
          priceCheck.other++;
          if (apiPrice) priceCheck.pct.push(Math.round((1 - domPrice / apiPrice) * 1000) / 10);
          if (priceCheck.samples.length < 8) {
            priceCheck.samples.push(`nm${nmId}: dom=${domPrice} api.product=${apiPrice} api.basic=${apiOld}`);
          }
        }
      }

      // рейтинг и отзывы (в DOM — число оценок; из API — число отзывов)
      const rating =
        parseNum(txt(card.querySelector('[data-testid="catalogCardRating"]'))) || (api && api.rating) || 0;
      const feedbacks = parseNum(txt(card.querySelector('[data-testid="catalogCardCommentCount"]')));
      const reviews = api ? api.reviews || 0 : 0;

      // бейджи акций
      const badges = [];
      for (const id of BADGE_IDS) {
        const b = txt(card.querySelector(`[data-testid="${id}"]`));
        if (b && b.length <= 40 && !/https?:/i.test(b)) badges.push(b);
      }

      // Ресейл (товар от частного лица): признак из JSON-каталога, который мы
      // перехватили (api.is_resale). Такие карточки — не наши конкуренты: их не
      // парсим, а в выдаче помечаем бейджем.
      const isResale = !!(api && api.is_resale);
      if (isResale && !badges.includes("ресейл")) badges.push("ресейл");

      // остаток («Осталось 3 шт»)
      const stock = txt(card.querySelector('[class*="thermometerText"]'));

      // картинка: WB меняет разметку и лениво грузит миниатюры — собираем со
      // всех img/bg в карточке (cardImage), маркер /<nm>/images/ отсекает рекламу
      const imageUrl = cardImage(card, nmId);

      products.push({
        id: nmId,
        position,
        name,
        brand,
        price,
        old_price: oldPrice,
        biz_price: bizPrice,
        rating,
        feedbacks,
        reviews,
        badges,
        stock,
        seller: api ? api.supplier || "" : "",
        promo_id: api ? api.promo_id || 0 : 0,
        imageUrl,
        sold_out: soldOut,
        is_resale: isResale,
      });
    }
    lastSkipped = skipped;
    return products;
  }

  function send(products) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "WB_SEARCH_RESULT", data: { phrase, products, search_stamp: stampFor(phrase) } }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || { ok: false, error: "нет ответа" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // ===== Индикатор сбора (как на карточке товара) =====
  const UI_KEY = "wbcms:search";
  let ui = null;

  function stateKey() {
    return UI_KEY + ":" + normPhrase(phrase);
  }
  function loadState() {
    try {
      return JSON.parse(sessionStorage.getItem(stateKey()) || "null");
    } catch {
      return null;
    }
  }
  function saveState(st) {
    try {
      sessionStorage.setItem(stateKey(), JSON.stringify(st));
    } catch {}
  }
  function agoText(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return "";
    const m = Math.round(ms / 60000);
    if (m < 1) return "только что";
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.round(h / 24)} дн назад`;
  }

  function mountUI() {
    if (!document.body) return;
    const old = document.getElementById("wbcms-search-fab-host");
    if (old) old.remove();
    const host = document.createElement("div");
    host.id = "wbcms-search-fab-host";
    // Левый верхний угол — как на карточке (правый низ на поиске занят фильтрами).
    host.style.cssText = "position:fixed;left:12px;top:96px;z-index:2147483000;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .wrap{display:flex;gap:6px;align-items:stretch}
        .btn{border:0;border-radius:10px;padding:9px 14px;font:600 12px/1.2 'Segoe UI',Arial,sans-serif;color:#fff;background:#cb11ab;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.18);white-space:nowrap}
        .btn:disabled{opacity:.75;cursor:default}
        .btn.ok{background:#2e7d32}
        .btn.warn{background:#ef6c00}
        .btn.err{background:#c62828}
        .re{border:0;border-radius:10px;padding:0 11px;background:#fff;color:#cb11ab;font-size:15px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.18)}
        .hint{margin-top:4px;font:400 10px/1.35 'Segoe UI',Arial,sans-serif;color:#6b7280;text-align:left;max-width:280px}
        .hint b{color:#374151}
      </style>
      <div>
        <div class="wrap">
          <button class="btn" id="cap">Собрать выдачу</button>
          <button class="re" id="re" title="Собрать заново (позиции + файлы)">↻</button>
        </div>
        <div class="hint" id="hint"></div>
      </div>`;
    document.body.appendChild(host);
    ui = {
      btn: shadow.getElementById("cap"),
      re: shadow.getElementById("re"),
      hint: shadow.getElementById("hint"),
    };
    ui.btn.addEventListener("click", () => collectNow({ manual: true }));
    ui.re.addEventListener("click", () => collectNow({ manual: true, forceRaw: true }));
    renderUI();
  }

  function setUI(state, text, hint) {
    if (!ui) return;
    ui.btn.className = "btn" + (state ? " " + state : "");
    ui.btn.disabled = state === "busy";
    if (text) ui.btn.textContent = text;
    if (hint !== undefined) ui.hint.textContent = hint || "";
  }

  function renderUI() {
    const st = loadState();
    if (!st) {
      setUI("", "Собрать выдачу", "выдача → позиции, цены, бейджи");
      return;
    }
    const files = Number(st.files) || 0;
    const when = agoText(st.at);
    if (st.empty) {
      setUI("warn", "Пусто", `WB не нашла товаров по этому запросу · ${when} · ↻ — пересобрать`);
    } else if (st.ok) {
      setUI("ok", `✓ ${st.saved || 0} позиций`, `файлов: ${files} · ${when} · ↻ — пересобрать`);
    } else if (st.saved) {
      setUI("warn", `⚠ ${st.saved || 0} позиций`, `${st.error || "файлы не сохранены"} · ${when} · ↻ — пересобрать`);
    } else {
      setUI("err", "✗ Ошибка", `${st.error || "нет связи с сервером"} · ${when} · ↻ — повторить`);
    }
  }

  // Отложенный сбор (после смены поиска — дать WB перерисовать выдачу).
  let collectTimer = null;
  function scheduleCollect(delay = 500) {
    if (collectTimer) clearTimeout(collectTimer);
    collectTimer = setTimeout(() => {
      collectTimer = null;
      collectNow();
    }, delay);
  }

  // Сбор выдачи: позиции/цены/бейджи (DOM) + сырые ответы WB (файлы и JSON-разбор).
  async function collectNow({ manual = false, forceRaw = false } = {}) {
    if (isProductPage() || (!pathIsSearch() && !domIsSearch())) {
      if (manual) setUI("err", "Это не поиск", "откройте страницу выдачи WB");
      return null;
    }
    const products = extract();
    if (!products.length) {
      if (isEmptyResult()) {
        // WB не нашла товаров по этому запросу — это ответ, а не «ещё грузится».
        // Позиции не отправляем (чтобы не стереть ранее собранные данные),
        // но состояние показываем явно.
        const at = new Date().toISOString();
        setUI("warn", "Пусто", "WB: по этому запросу ничего не найдено");
        saveState({ at, ok: true, saved: 0, files: 0, empty: true, error: "" });
        return null;
      }
      if (manual) setUI("err", "Нет выдачи", "страница не похожа на выдачу");
      return null;
    }
    // Каталог JSON пришёл, но ни одной его карточки нет в DOM → DOM ещё от
    // предыдущего запроса: ждём перерисовки, иначе запишем чужие позиции.
    if (apiById.size) {
      const hit = products.filter((p) => apiById.has(p.id)).length;
      if (hit === 0) {
        if (manual) setUI("", "Ждём выдачу…", "страница ещё обновляется");
        return null;
      }
    }
    setUI("busy", "Сохраняем…", "");

    // фото-диагностика: сколько карточек без картинки (пустой image_url)
    const emptyImg = emptyCount(products);
    if (emptyImg) console.log(`[SEARCH] миникартинок нет у ${emptyImg}/${products.length}`);

    const domRes = await send(products);
    const okDom = !!(domRes && domRes.ok);
    console.log(
      `[SEARCH] позиции («${phrase}»): ${okDom ? "сохранено" : "НЕ сохранено"} · ${products.length} шт` +
        ` · статус ${(domRes && domRes.status) || 0}${(domRes && domRes.error) ? " · " + domRes.error : ""}`
    );

    if (forceRaw) for (const k of Object.keys(sentSig)) delete sentSig[k];
    await flushRaw();

    // Итог по файлам: считаем, что пришло от сервера.
    let files = 0;
    let rawErr = "";
    for (const kind of Object.keys(rawParts)) {
      const part = rawParts[kind];
      const key = `${kind}|${normPhrase(part.phrase)}`;
      if (sentSig[key] === sigOf(part.raw || "")) files++;
      else rawErr = "файлы не все сохранены";
    }

    // Запоминаем, сколько картинок не доехало — ретраем до 2 раз (armImageRetry)
    lastSentEmpty = emptyImg;
    if (okDom && emptyImg > 0) armImageRetry();

    const saved = products.length;
    const at = new Date().toISOString();
    const ok = okDom && !rawErr;
    let state = "";
    let text = `✓ ${saved} позиций`;
    let hint = `файлов: ${files} · ${agoText(at)} · ↻ — пересобрать`;
    if (!okDom) {
      state = "err";
      text = "✗ Ошибка";
      hint = `${(domRes && domRes.error) || "нет связи с сервером"} · ${agoText(at)} · ↻ — повторить`;
    } else if (rawErr) {
      state = "warn";
      text = `⚠ ${saved} позиций`;
      hint = `${rawErr} · ${agoText(at)} · ↻ — пересобрать`;
    }
    setUI(state, text, hint);
    saveState({ at, ok, saved, files, error: rawErr || (domRes && domRes.error) || "" });
    return { domRes };
  }

  // Догрузили выдачу (прокрутка) → JSON пришёл новый → шлём обновление.
  let resendTimer = null;
  function scheduleResend() {
    if (resendTimer) clearTimeout(resendTimer);
    resendTimer = setTimeout(() => {
      resendTimer = null;
      if (!sent) return;
      if (!searchPage()) return;
      const products = extract();
      if (!products.length) return;
      console.log(`[SEARCH] догрузка выдачи → ${products.length} карточек`);
      collectNow();
    }, 2000);
  }

  // ===== Картинки: ожидание ленивых миниатюр + ретрай =====
  // WB рисует миниатюры по мере рендера/прокрутки (lazy): чтобы не положить в
  // базу выдачу с пустыми image_url, перед первым отправом ждём, пока доля
  // пустых перестанет убывать (до ~3.5 с), а после отправа ещё до 2 раз досылаем
  // апдейт, если картинок стало видно больше.
  const IMG_STABLE_WAIT_MS = 3500;
  let imgStable = { t0: 0, last: -1 };   // ожидание перед первым отправом
  let lastSentEmpty = -1;                // сколько было пустых при прошлой отправке
  let imgRetryTimer = null;
  let imgRetryLeft = 0;                  // исполненных ретраев (максимум 2)

  function emptyCount(products) {
    let e = 0;
    for (const p of products) if (!p.imageUrl) e++;
    return e;
  }

  function imagesStable(products) {
    if (!products.length) return true;
    const empty = emptyCount(products);
    if (empty === 0) return true;
    if (!imgStable.t0) {
      imgStable = { t0: Date.now(), last: empty };
      return false;                      // первый пробег — дадим миниатюрам доехать
    }
    if (empty < imgStable.last && Date.now() - imgStable.t0 < IMG_STABLE_WAIT_MS) {
      imgStable.last = empty;            // картинок стало больше — ждём дальше
      return false;
    }
    return true;                         // прогресса нет или ждём слишком долго
  }

  function armImageRetry() {
    if (imgRetryTimer || imgRetryLeft >= 2 || scrollRunning) return;
    imgRetryTimer = setTimeout(() => {
      imgRetryTimer = null;
      imgRetryLeft++;
      if (scrollRunning || !searchPage() || collectedPhrase !== phrase) return;
      const products = extract();
      if (!products.length) return;
      const empty = emptyCount(products);
      if (empty === 0 || empty >= lastSentEmpty) return;   // улучшения нет
      console.log(`[SEARCH] ретрай картинок: пустых ${empty} из ${products.length}`);
      collectNow();
    }, IMG_STABLE_WAIT_MS);
  }

  // ===== Скролл-досбор картинок (командует background — только свои вкладки) =====
  // WB лениво рисует миниатюры и грузит пагинацию только при прокрутке, поэтому
  // фоновый поток после первого посыла держит вкладку и командует скролл до
  // ТОП-N. По ходу новые страницы JSON ловятся через onSearchEnvelope; в конце —
  // финальный апдейт (его background досохранит и закроет вкладку).
  const SCROLL_TARGET_POS = 40;
  let scrollRunning = false;

  async function scrollCollect(maxMs = 9000) {
    if (scrollRunning || !searchPage()) return;
    scrollRunning = true;
    const t0 = Date.now();
    let lastPos = 0;
    let stuck = 0;
    console.log(`[SEARCH] скролл-досбор: цель позиция ${SCROLL_TARGET_POS}, окно ${maxMs} мс`);
    try {
      while (Date.now() - t0 < maxMs) {
        const products = extract();
        let maxPos = 0;
        let emptyTop = 0;
        for (const p of products) {
          if (p.position > maxPos) maxPos = p.position;
          if (p.position <= SCROLL_TARGET_POS && !p.imageUrl) emptyTop++;
        }
        if (maxPos >= SCROLL_TARGET_POS && emptyTop === 0) break;   // всё доехало
        const before = window.scrollY;
        window.scrollBy(0, Math.max(400, Math.round((window.innerHeight || 800) * 1.4)));
        if (window.scrollY === before) {
          if (maxPos <= lastPos) stuck++;
          if (stuck >= 2) break;                       // доскроллили до дна
        } else {
          stuck = 0;
        }
        lastPos = maxPos;
        await new Promise((r) => setTimeout(r, 450));
      }
    } catch {}
    scrollRunning = false;
    console.log(`[SEARCH] скролл-досбор: ${((Date.now() - t0) / 1000).toFixed(1)} с → апдейт`);
    await collectNow();
  }

  let attempts = 0;
  let captchaSent = false;
  let sent = false;
  let collectedPhrase = ""; // для какой фразы уже собрали

  const timer = setInterval(() => {
    // 1) Сменился поиск? WB — SPA: адрес меняется без перезагрузки страницы.
    //    Основной путь — привязка к query= в самих ответах WB (быстрее и без гонки),
    //    этот — подстраховка, если по новой фразе WB ничего не прислал.
    const cur = pickPhrase();
    if (cur && cur !== phrase) switchContext(cur);
    // 2) Результат капчи: только на странице выдачи или при капча-редиректе.
    //    На карточке фонового сбора свою капчу репортит content.js — иначе
    //    мы бы гасили чужой поток по строчке текста с карточки.
    const cap = location.href.toLowerCase().includes("captcha") || searchPage() ? captchaReason() : "";
    if (cap) {
      if (!captchaSent) {
        captchaSent = true;
        console.warn(`[SEARCH] captcha on "${phrase}"`, location.href);
        chrome.runtime.sendMessage({ type: "CAPTCHA", data: { url: location.href, phrase, where: "search" } });
      }
      return;
    }
    // 3) Автосбор — только на странице выдачи: «похожие товары» на карточке
    //    фонового сбора не должны записываться как результат поиска.
    if (!searchPage()) return;
    // Уже собрали для этой фразы — ждём догрузку (её обработает scheduleResend).
    if (collectedPhrase === phrase) return;
    attempts++;
    const products = extract();
    const isEmpty = isEmptyResult();
    if (!products.length && !isEmpty) {
      if (attempts > 15) attempts = 15;
      return;
    }
    // JSON-выдача WB приходит вместе с DOM — подождём её до 6 с, но не бесконечно
    if (products.length && !apiById.size && attempts < 6) return;
    // Лениво нарисованные миниатюры: если картинок много пустых — даём до
    // ~3.5 с, пока доля пустых перестанет убывать (imagesStable), иначе
    // записали бы выдачу с пустыми image_url.
    if (products.length && !scrollRunning && !imagesStable(products)) return;

    if (!phrase) phrase = pickPhrase();
    ensureStamp();
    collectedPhrase = phrase;
    const isSearch = searchPage();
    console.log(
      `[SEARCH] "${phrase}" → ${products.length} карточек${isEmpty ? " (empty)" : ""}` +
        `${apiById.size ? ` (JSON: ${apiById.size})` : " (без JSON)"}`,
      isSearch ? "выдача" : "не выдача (пропускаем)"
    );
    if (priceCheck.dom) {
      const pct = priceCheck.pct.length
        ? `, дешевле на ${(priceCheck.pct.reduce((a, b) => a + b, 0) / priceCheck.pct.length).toFixed(1)}% (кошелёк WB)`
        : "";
      console.log(
        `[SEARCH] цена DOM vs WB API: ${priceCheck.dom} карточек` +
          `, совпало с product ${priceCheck.eqProduct}, с basic ${priceCheck.eqBasic}, иначе ${priceCheck.other}${pct}`,
        priceCheck.samples
      );
    }
    // Диагностика рекламы: что есть в DOM, но нет в JSON-выдаче.
    if (apiById.size) {
      const domIds = new Set(products.map((p) => p.id));
      const onlyDom = [...domIds].filter((id) => !apiById.has(id));
      console.log(
        `[SEARCH] реклама/витрины: dom=${domIds.size} json=${apiById.size} ` +
          `только-DOM=${onlyDom.length} отброшено=${lastSkipped}`,
        onlyDom.slice(0, 20)
      );
    }
    if (!isSearch) return;   // это не выдача (похожие товары на карточке) — не отправляем
    if (!phrase) {
      console.warn("[SEARCH] нет фразы — отправляю с пустой (сервер отклонит)");
    }
    sent = true;
    collectNow();
  }, 1000);

  // SPA: WB переходит из выдачи в карточку без перезагрузки — кнопка «Собрать
  // выдачу» тогда остаётся и перекрывает кнопку карточки (content.js). Делим по
  // URL: на странице товара (/catalog/<nm>/detail) свою кнопку убираем,
  // вернулись на выдачу — монтируем заново (состояние живёт в storage).
  function isProductPage() {
    return /\/catalog\/\d+\/detail/.test(location.pathname);
  }

  // ===== ПЛАШКА ПРОГРЕССА СБОРА =====
  // Живёт только в той вкладке, из которой запустили сбор: сбор идёт в
  // отдельных вкладках, а в «рабочей» вкладке плашка никому не мешает.
  // В левом верхнем углу — рядом с кнопкой «Собрать выдачу».
  let progHost = null;
  let progHideTimer = null;

  function mountProgressPlate() {
    if (progHost) return;
    progHost = document.createElement("div");
    progHost.id = "wbcms-progress-host";
    progHost.style.cssText = "position:fixed;left:12px;top:168px;z-index:2147483000;";
    const shadow = progHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .box{background:linear-gradient(180deg,#ffffff 0%,#fdf1f9 100%);
             border:1px solid #f2b8dd;border-radius:14px;padding:11px 15px;
             box-shadow:0 8px 26px rgba(203,17,171,.22);
             font:700 15px/1.35 'Segoe UI',Arial,sans-serif;color:#6b21a8;
             max-width:380px}
        .box.done{border-color:#9ccc65;background:linear-gradient(180deg,#ffffff 0%,#f1fbf0 100%);
                  color:#2e7d32;box-shadow:0 8px 26px rgba(46,125,50,.18)}
        .row{display:flex;align-items:center;gap:9px}
        .spin{width:14px;height:14px;border:3px solid #cb11ab;border-right-color:transparent;border-radius:50%;
             animation:sp 1s linear infinite;flex:0 0 auto}
        @keyframes sp{to{transform:rotate(360deg)}}
        .stop{margin-left:auto;border:0;border-radius:8px;padding:5px 12px;cursor:pointer;
              background:#ef6c00;color:#fff;font:700 13px/1.2 'Segoe UI',Arial,sans-serif}
        .stop:hover{background:#e65100}
        .bar{height:6px;background:#e9edf3;border-radius:3px;margin-top:9px;overflow:hidden}
        .bar>i{display:block;height:100%;background:#cb11ab;width:0;transition:width .3s}
        .cur{margin-top:7px;font:500 13px/1.35 'Segoe UI',Arial,sans-serif;color:#7b6a86}
      </style>
      <div class="box" id="box">
        <div class="row">
          <span class="spin" id="spin"></span>
          <span id="txt">Сбор…</span>
          <button class="stop" id="stop" title="Остановить текущий сбор">Стоп</button>
        </div>
        <div class="bar"><i id="bar"></i></div>
        <div class="cur" id="cur"></div>
      </div>`;
    document.body.appendChild(progHost);
  }

  function renderProgressPlate(prog) {
    if (!prog) return;
    if (prog.finished) {
      if (progHideTimer) clearTimeout(progHideTimer);
      progHideTimer = setTimeout(() => {
        if (progHost) { progHost.remove(); progHost = null; }
      }, 10000);
    }
    mountProgressPlate();
    bindProgressStop();
    const shadow = progHost.shadowRoot;
    const box = shadow.getElementById("box");
    const txt = shadow.getElementById("txt");
    const spin = shadow.getElementById("spin");
    const bar = shadow.getElementById("bar");
    const cur = shadow.getElementById("cur");
    const stopBtn = shadow.getElementById("stop");
    if (prog.finished) {
      box.classList.add("done");
      spin.style.display = "none";
      if (stopBtn) stopBtn.style.display = "none";
      txt.textContent = prog.stopped ? "Остановлено" : "\u2713 Готово";
      cur.textContent = "";
      bar.style.width = "100%";
      return;
    }
    box.classList.remove("done");
    spin.style.display = "";
    if (stopBtn) stopBtn.style.display = "";
    const total = prog.total || 0;
    const done = prog.done || 0;
    txt.textContent = total ? `Сбор ${done} · в очереди ${total}` : `Сбор ${done}`;
    bar.style.width = total ? `${Math.min(100, Math.round((done / total) * 100))}%` : "0%";
    cur.textContent = prog.current ? `сейчас: ${prog.current}` : "";
  }

  // Кнопка «Стоп» в плашке: останавливает текущий поток сбора.
  function bindProgressStop() {
    if (!progHost) return;
    const shadow = progHost.shadowRoot;
    const stopBtn = shadow.getElementById("stop");
    if (!stopBtn || stopBtn.dataset.bound) return;
    stopBtn.dataset.bound = "1";
    stopBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      stopBtn.disabled = true;
      stopBtn.textContent = "Стоп…";
      try {
        await chrome.runtime.sendMessage({ type: "WB_STOP_RUN" });
      } catch {}
      // Плашка погаснет по сообщению от background (finished + stopped)
      setTimeout(() => {
        if (progHost) { progHost.remove(); progHost = null; }
      }, 5000);
    });
  }

  async function initProgressPlate() {
    try {
      const st = await chrome.runtime.sendMessage({ type: "WB_PROGRESS_STATE" });
      if (st && st.isSource && st.prog) renderProgressPlate(st.prog);
    } catch {}
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "WB_PROGRESS") renderProgressPlate(msg.prog || {});
    // Скролл-досбор картинок: команду отправляет только background своим
    // вкладкам фонового поиска — ручную вкладку человека не трогаем.
    if (msg && msg.type === "WB_SEARCH_SCROLL") {
      scrollCollect(Math.max(3000, Number(msg.maxMs) || 9000));
    }
  });

  function syncUI() {
    const host = document.getElementById("wbcms-search-fab-host");
    // Панель «Собрать выдачу» — только там, где выдача есть и сбор имеет смысл:
    // страница поиска (по URL: /search.aspx, /search/?query=… или контейнер
    // .product-card-list). На главной, в категориях, в корзине кнопка бессмысленна.
    if (!searchPage()) {
      if (host) host.remove();
    } else if (!host && document.body) {
      mountUI();
    }
  }
  setInterval(syncUI, 1000);

  // Индикатор сбора — как на карточке товара.
  if (document.body) syncUI();
  else document.addEventListener("DOMContentLoaded", syncUI, { once: true });

  // Плашка прогресса — только в вкладке, из которой запустили сбор.
  if (document.body) initProgressPlate();
  else document.addEventListener("DOMContentLoaded", initProgressPlate, { once: true });
})();
