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

  // Фраза: из URL, иначе из поля поиска в шапке.
  function pickPhrase() {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get("search") || u.searchParams.get("query") || "";
      if (q) return q.trim();
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

  // Бейджи акций/промо: что нашли — складываем в массив строк
  const BADGE_IDS = ["saleBadge", "promoBadge", "goodPriceBadge", "cashbackBadge"];

  // ==========================================================================
  // Данные выдачи из JSON WB (перехват hook_wb_api.js, MAIN world).
  // Точные: продавец, число отзывов, id промо-панели, цены в копейках.
  // ==========================================================================
  const apiById = new Map();
  let apiGot = false;
  let sent = false;

  function onApiItems(items) {
    let added = 0;
    for (const it of items) {
      const id = Number(it && it.id) || 0;
      if (!id) continue;
      if (!apiById.has(id)) added++;
      apiById.set(id, it);
    }
    apiGot = true;
    if (added) console.log(`[SEARCH] JSON WB: ${apiById.size} товаров (+${added})`);
    if (added && sent) scheduleResend();
  }

  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (typeof data !== "string") return;
    if (data.indexOf("WB_SEARCH_JSON_V1") < 0) return;
    let msg = null;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && msg.type === "WB_SEARCH_JSON_V1" && Array.isArray(msg.items)) onApiItems(msg.items);
  });
  // запасной канал (CustomEvent на document)
  document.addEventListener("WB_SEARCH_JSON_V1", (ev) => {
    const raw = ev && ev.detail;
    if (typeof raw !== "string") return;
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && msg.type === "WB_SEARCH_JSON_V1" && Array.isArray(msg.items)) onApiItems(msg.items);
  });

  // Сверка DOM-цены с ценой WB API: где расходится — пишем в консоль (диагностика).
  let priceCheck = { dom: 0, eqProduct: 0, eqBasic: 0, other: 0, samples: [] };

  function extract() {
    const cards = document.querySelectorAll("article.product-card, [data-nm-id]");
    const products = [];
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
      const price = domPrice || apiPrice;
      const oldPrice = domOld || apiOld;

      if (api && domPrice && priceCheck.dom < 400) {
        priceCheck.dom++;
        if (domPrice === apiPrice) priceCheck.eqProduct++;
        else if (domPrice === apiOld) priceCheck.eqBasic++;
        else {
          priceCheck.other++;
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

      // остаток («Осталось 3 шт»)
      const stock = txt(card.querySelector('[class*="thermometerText"]'));

      // картинка
      const img =
        card.querySelector("img.j-thumbnail") ||
        card.querySelector("img[data-src-pb]") ||
        card.querySelector('img[src*="/images/"]');
      let imageUrl = (img && (img.getAttribute("data-src-pb") || img.getAttribute("src") || img.src)) || "";
      if (imageUrl && imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;

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
      });
    }
    return products;
  }

  function send(products) {
    sent = true;
    chrome.runtime.sendMessage({ type: "WB_SEARCH_RESULT", data: { phrase, products } });
  }

  // Догрузили выдачу (прокрутка) → JSON пришёл новый → шлём обновление.
  let resendTimer = null;
  function scheduleResend() {
    if (resendTimer) clearTimeout(resendTimer);
    resendTimer = setTimeout(() => {
      resendTimer = null;
      if (!sent) return;
      if (!pathIsSearch() && !domIsSearch()) return;
      const products = extract();
      if (!products.length) return;
      console.log(`[SEARCH] догрузка выдачи → ${products.length} карточек`);
      send(products);
    }, 2000);
  }

  let attempts = 0;
  let captchaSent = false;
  const timer = setInterval(() => {
    attempts++;
    if (captchaReason()) {
      clearInterval(timer);
      if (!captchaSent) {
        captchaSent = true;
        console.warn(`[SEARCH] captcha on "${phrase}"`, location.href);
        chrome.runtime.sendMessage({ type: "CAPTCHA", data: { url: location.href, phrase, where: "search" } });
      }
      return;
    }
    const products = extract();
    const isEmpty = document.body.textContent.includes("Не нашлось подходящих товаров");
    if (!products.length && !isEmpty) {
      if (attempts > 15) clearInterval(timer);
      return;
    }
    // JSON-выдача WB приходит вместе с DOM — подождём её до 6 с, но не бесконечно
    if (products.length && !apiGot && attempts < 6) return;

    clearInterval(timer);
    if (!phrase) phrase = pickPhrase();
    const isSearch = pathIsSearch() || domIsSearch();
    console.log(
      `[SEARCH] "${phrase}" → ${products.length} карточек${isEmpty ? " (empty)" : ""}` +
        `${apiGot ? ` (JSON: ${apiById.size})` : " (без JSON)"}`,
      isSearch ? "выдача" : "не выдача (пропускаем)"
    );
    if (priceCheck.dom) {
      console.log(
        `[SEARCH] сверка цены DOM vs WB API: всего ${priceCheck.dom}, ` +
          `совпало с product ${priceCheck.eqProduct}, с basic ${priceCheck.eqBasic}, расхождений ${priceCheck.other}`,
        priceCheck.samples
      );
    }
    if (!isSearch) return;   // это не выдача (похожие товары на карточке) — не отправляем
    // Отправляем ВСЕГДА: если это поиск самого расширения — background знает про
    // очередь (searchQueue) и сохранит по ней; если поиск сделал человек —
    // background сохранит как наблюдение (observe_search).
    if (!phrase) {
      console.warn("[SEARCH] нет фразы — отправляю с пустой (сервер отклонит)");
    }
    send(products);
  }, 1000);
})();
