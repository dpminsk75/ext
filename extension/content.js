(() => {
  const NM_RE = /\/catalog\/(\d+)\/detail/;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const VER = (() => {
    try { return chrome.runtime.getManifest().version; } catch { return "?"; }
  })();

  let running = false;
  let lastPath = location.pathname;

  // Видно сразу при загрузке страницы: подтверждение, что инжектирован НОВЫЙ content.js.
  console.log(`[WB-CMS] content v${VER}`, location.pathname);

  function nmFromPath() {
    const m = location.pathname.match(NM_RE);
    return m ? parseInt(m[1], 10) : null;
  }

  // WB отдаёт антибот-заглушку вместо карточки. Если её принять за карточку,
  // в базу уедет пустое описание, а очередь будет считать карточку собранной.
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

  let captchaSent = false;

  async function reportCaptcha(where) {
    if (captchaSent) return;
    captchaSent = true;
    console.warn(`[WB-CMS] captcha (${where})`, location.href);
    if (ui) setUI("err", "WB просит капчу", "решите капчу в этой вкладке и запустите снова");
    await sendBG({ type: "CAPTCHA", data: { nm: nmFromPath(), url: location.href, where } });
  }

  function clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  // «180 ₽» / «1 490 ₽» → 180 / 1490 (там &nbsp;)
  function parseRub(txt) {
    const m = String(txt || "").match(/\d[\d\s ]*/);
    if (!m) return 0;
    const n = parseInt(m[0].replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }
  function parseNum(txt) {
    const s = String(txt || "").replace(/[\s ]/g, "").replace(",", ".");
    const m = s.match(/\d+(\.\d+)?/);
    if (!m) return 0;
    const n = parseFloat(m[0]);
    return Number.isFinite(n) ? n : 0;
  }
  function visible(el) {
    if (!el) return false;
    // «Характеристики и описание» — выдвижной drawer: видимость блока внутри
    // определяется видимостью самого drawer'а, а не вложенного элемента.
    const box = el.closest('[role="dialog"], [class*="drawer"], [class*="Drawer"]');
    const target = box || el;
    if (target.offsetParent === null && target.getClientRects().length === 0) return false;
    if (typeof target.checkVisibility === "function") {
      try { if (!target.checkVisibility()) return false; } catch {}
    }
    return clean(el.textContent || el.innerText || "").length > 0;
  }

  // Бейджи акций/промо — складываем в массив строк (одно поле в БД).
  const BADGE_IDS = ["saleBadge", "promoBadge", "goodPriceBadge", "cashbackBadge"];
  function collectBadges(root) {
    const out = [];
    for (const id of BADGE_IDS) {
      const b = clean((root.querySelector(`[data-testid="${id}"]`) || {}).textContent || "");
      // только короткий текст-подпись; ссылки и прочий мусор отбрасываем
      if (b && b.length <= 40 && !/https?:/i.test(b) && !out.includes(b)) out.push(b);
    }
    return out;
  }
  // На карточке товара бейджи без data-testid (карусель .badges--*) — добираем отдельно.
  function allBadges() {
    const out = collectBadges(document);
    for (const b of collectCardBadges()) {
      if (!out.includes(b)) out.push(b);
    }
    return out;
  }

  // Рейтинг / оценки / вопросы — блок productCommonInfo--XMAON (data-testid стабильнее классов).
  function collectCommonInfo() {
    const out = { rating: 0, feedbacks: 0, questions: 0 };
    try {
      const rev = document.querySelector('[data-testid="product-header-reviews"]');
      if (rev) {
        const r = rev.querySelector('[class*="productReviewRating"]') ||
          rev.querySelector('[class*="rating"]');
        const t = clean(r ? r.textContent : rev.textContent);
        // «5  ·  93 оценки»
        const m = t.match(/(\d+[.,]?\d*)\s*·\s*(\d+)/);
        if (m) {
          out.rating = parseNum(m[1]);
          out.feedbacks = parseInt(m[2], 10) || 0;
        } else {
          const rr = t.match(/(\d+[.,]\d+)/);
          const fb = t.match(/(\d+)\s*оцен/);
          if (rr) out.rating = parseNum(rr[1]);
          if (fb) out.feedbacks = parseInt(fb[1], 10) || 0;
        }
      }
      const q = document.querySelector('[data-testid="product-header-questions"]');
      if (q) {
        const c = q.querySelector('[class*="productQuestionsCount"]') || q;
        const t = clean(c.textContent);
        const m = t.match(/(\d+)\s*вопрос/);
        if (m) out.questions = parseInt(m[1], 10) || 0;
      }
    } catch {}
    return out;
  }

  // Описание: ВСЕ абзацы (раньше брался только первый <p>).
  function findDescSection() {
    let sec = document.querySelector("#section-description");
    if (sec && (sec.innerText || "").trim()) return sec;

    sec = document.querySelector('[data-tag*="description" i]');
    if (sec && (sec.innerText || "").trim()) return sec;

    const heads = [...document.querySelectorAll("h1, h2, h3, h4, h5")].filter((e) =>
      /^описание$/i.test((e.innerText || "").replace(/\s+/g, " ").trim())
    );
    for (const h of heads) {
      let node = h.parentElement;
      for (let i = 0; i < 4 && node; i++) {
        if ((node.innerText || "").length > 60) return node;
        node = node.parentElement;
      }
      if (h.parentElement) return h.parentElement;
    }
    return null;
  }

  function parseDescription() {
    const sec = findDescSection();
    if (!sec) return "";
    const ps = [...sec.querySelectorAll("p")].map((p) => p.innerText.trim()).filter(Boolean);
    if (ps.length) return ps.join("\n\n").slice(0, 20000);
    let text = (sec.innerText || "").trim();
    text = text.replace(/^Описание\s*/i, "");
    return text.slice(0, 20000);
  }

  // Контейнеры характеристик: вёрстка WB меняется между релизами.
  // - старый WB: #section-characteristics;
  // - новый (host 14.x): section[data-testid="product_additional_information"] с таблицами
  //   «Дополнительная информация» и «Габариты», лежит перед #section-description.
  function collectCharSections() {
    const out = [];
    const add = (el) => { if (el && !out.includes(el)) out.push(el); };

    add(document.querySelector("#section-characteristics"));
    add(document.querySelector('[data-testid="product_additional_information"]'));
    document.querySelectorAll('[data-testid*="characteristic" i]').forEach(add);

    const desc = document.querySelector("#section-description");
    const root = desc && desc.parentElement;
    if (root) {
      root.querySelectorAll("section").forEach((s) => {
        if (s !== desc && s.querySelector("tr th, tr td")) add(s);
      });
      root.querySelectorAll("table").forEach((t) => {
        if (t.querySelector("tr th") && t.querySelector("tr td")) add(t);
      });
    }

    document.querySelectorAll('[class*="characteristic" i]').forEach((el) => {
      if ((el.innerText || "").length > 40) add(el);
    });

    // если появится заголовок «Характеристики»
    [...document.querySelectorAll("h1, h2, h3, h4, h5")].forEach((h) => {
      if (!/^характеристики$/i.test((h.innerText || "").replace(/\s+/g, " ").trim())) return;
      let node = h.parentElement;
      for (let i = 0; i < 4 && node; i++) {
        if (node.querySelector("tr th")) { add(node); return; }
        node = node.parentElement;
      }
    });

    return out;
  }

  // Характеристики: [{name, value[]}] в формате wbcards.characteristics.
  // Таблицы (th = имя, td = значение) — основной путь; остальные стратегии — фолбэк.
  function parseCharacteristics() {
    const sections = collectCharSections();
    if (!sections.length) return [];
    const out = [];
    const seen = new Set();

    const push = (name, values) => {
      const n = clean(name).replace(/[:\s]+$/, "");
      if (!n || n.length > 120) return;
      let vals = Array.isArray(values) ? values : [values];
      vals = vals.map((v) => clean(v)).filter(Boolean);
      if (!vals.length) return;
      const key = n.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name: n, value: vals });
    };
    const splitLines = (el) =>
      (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);

    // 1) таблицы: <tr><th>имя</th><td>значение</td></tr>
    for (const sec of sections) {
      for (const tr of sec.querySelectorAll("tr")) {
        const cells = [...tr.querySelectorAll("th,td")].filter((c) => clean(c.innerText));
        if (cells.length >= 2) push(cells[0].innerText, cells.slice(1).flatMap(splitLines));
      }
    }

    // 2) dl/dt/dd
    if (!out.length) {
      for (const sec of sections) {
        for (const dt of sec.querySelectorAll("dt")) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === "DD") push(dt.innerText, splitLines(dd));
        }
      }
    }

    // 3) строки из двух ячеек (div/li без table)
    if (!out.length) {
      for (const sec of sections) {
        for (const row of sec.querySelectorAll("div, li")) {
          const kids = [...row.children].filter((el) => clean(el.textContent));
          if (kids.length !== 2) continue;
          const [a, b] = kids;
          if (clean(a.textContent).length > 70) continue;
          push(a.innerText, splitLines(b));
        }
      }
    }

    // 4) фолбэк: текст "Ключ: значение" построчно
    if (!out.length) {
      for (const sec of sections) {
        for (const line of (sec.innerText || "").split("\n")) {
          const ln = clean(line);
          const i = ln.indexOf(":");
          if (i > 1 && i < 60) push(ln.slice(0, i), ln.slice(i + 1));
        }
      }
    }

    return out.slice(0, 100);
  }

  // Картинки галереи. Классы WB меняются, поэтому идём от src: /<nm>/images/<размер>/N.webp.
  // Фильтр по nm отсекает картинки из блоков рекомендаций.
  function parseImages(nmId) {
    const out = [];
    const seen = new Set();
    const marker = `/${nmId}/images/`;
    const pushUrl = (raw) => {
      if (!raw || !String(raw).includes(marker)) return;
      const url = String(raw).trim()
        .split("?")[0].split("#")[0]
        .replace(/^\/\//, "https://")
        .replace(/\/images\/[^/]+\//, "/images/c246x328/");
      if (!/\/images\/c246x328\/\d+\.(webp|jpg|jpeg|png)$/i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push(url);
    };
    const pushSrcset = (v) => {
      for (const part of String(v || "").split(",")) pushUrl(part.trim().split(/\s+/)[0]);
    };
    for (const img of document.querySelectorAll("img")) {
      // srcset: «url 1x, url 2x» — может быть единственным источником до ленивой загрузки
      pushUrl(img.currentSrc || img.src);
      pushSrcset(img.getAttribute("srcset"));
      pushSrcset(img.getAttribute("data-srcset"));
      for (const attr of ["data-src", "data-src-pb", "data-original", "data-lazy-src"]) {
        pushUrl(img.getAttribute(attr));
      }
      if (out.length >= 30) break;
    }
    return out;
  }

  // Рекомендации: любые ссылки на другие карточки, приоритет — блоки «похожие/рекомендуем».
  function parseRecommendations(nmId) {
    const prioRe = /(recommend|similar|похож|смотрите|также|cards-list|product-card|shelf)/i;
    const byNm = new Map();
    let seq = 0;
    for (const a of document.querySelectorAll('a[href*="/catalog/"]')) {
      const href = a.href || "";
      const m = href.match(/\/catalog\/(\d+)\/detail/i);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!n || n === nmId) continue;
      if (a.closest("header, nav, footer")) continue;
      const img = a.querySelector("img");
      const label = clean(a.getAttribute("aria-label") || (img && img.alt) || a.innerText || "").slice(0, 200);
      const box = a.closest(
        '[class*="recommend" i], [data-testid*="recommend" i], [class*="similar" i], ' +
        '[data-testid*="similar" i], [class*="cards-list" i], [class*="product-card" i]'
      );
      const prio = box || prioRe.test(String(a.className)) ? 0 : 1;
      const prev = byNm.get(n);
      if (prev && prev.prio <= prio) continue;
      byNm.set(n, {
        nm_id: n,
        href: `https://www.wildberries.ru/catalog/${n}/detail.aspx`,
        title: label,
        prio,
        seq: prev ? prev.seq : seq++,
      });
    }
    return [...byNm.values()]
      .sort((x, y) => x.prio - y.prio || x.seq - y.seq)
      .slice(0, 12)
      .map(({ nm_id, href, title }) => ({ nm_id, href, title }));
  }

  // Цена на карточке товара (разметка priceBlock--*):
  //   button[class*="priceBlockWalletPrice"] h2 — цена «с кошельком» (её видит покупатель);
  //   ins[class*="priceBlockFinalPrice"]        — цена без кошелька;
  //   span[class*="priceBlockOldPrice"]         — зачёркнутая.
  // 0 = «не нашли» (сервер такие значения не записывает).
  function findCardPrice() {
    const wallet = document.querySelector('[class*="priceBlockWalletPrice"] h2');
    if (wallet && /\d/.test(wallet.textContent || "")) return wallet;
    const direct = document.querySelector('h2[class*="mo-typography_colors_danger"]');
    if (direct && /\d/.test(direct.textContent || "")) return direct;
    const final = document.querySelector('ins[class*="priceBlockFinalPrice"]');
    if (final && /\d/.test(final.textContent || "")) return final;
    // общий запасной: первый в DOM элемент с текстом ровно «N ₽»
    // (внутри drawer'а цена другая — там подвал с ценой, её пропускаем)
    const all = document.querySelectorAll("ins, span, div, p, h2");
    const limit = Math.min(all.length, 600);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      if (el.closest('[role="dialog"], [class*="drawer"], [class*="Drawer"]')) continue;
      const t = (el.textContent || "").trim();
      if (/^\d[\d\s ]*₽$/.test(t)) return el;
    }
    return null;
  }

  // Кнопка «Все характеристики и описание» — открывает drawer с описанием и хар-ками.
  // Старый класс btnDetail мог смениться — ищем по тексту.
  function findDetailButton() {
    const old = document.querySelector('button[class*="btnDetail"]');
    if (old) return old;
    const btns = document.querySelectorAll('button, [role="button"], a, span, div');
    for (const b of btns) {
      // заголовок самого drawer'а «Характеристики и описание» — не кнопка
      if (b.closest('[role="dialog"], [class*="drawer"], [class*="Drawer"]')) continue;
      const t = clean(b.textContent || "");
      if (t.length < 80 && /характеристики\s+и\s+описание/i.test(t)) return b;
    }
    return null;
  }

  // Зачёркнутая цена — отдельный span priceBlockOldPrice (он соседний с ценой,
  // но не внутри кнопки), иначе первая же «del» может быть из рекомендаций.
  function findCardOldPrice(priceEl) {
    const old = document.querySelector('[class*="priceBlockOldPrice"]');
    if (old) return old;
    if (priceEl) {
      const block = priceEl.closest('[class*="priceBlock"]') || priceEl.parentElement;
      if (block) {
        const d = block.querySelector("del");
        if (d) return d;
      }
    }
    return document.querySelector('del[class*="price"]');
  }

  // «Нет в наличии» на карточке (и в выдаче — аналогичный блок): h2 soldOutProduct
  // в priceBlock. Класс у WB с hashed-хвостом → ищем по префиксу; страховка —
  // текст «Нет в наличии» внутри priceBlock.
  function cardSoldOut() {
    try {
      const h2 = document.querySelector('h2[class*="soldOutProduct"]');
      if (h2) {
        const t = (h2.textContent || "").replace(/\u00a0/g, " ").toLowerCase();
        if (/нет\s+в\s+наличии/.test(t)) return true;
      }
      const block = document.querySelector('[class*="priceBlock"]');
      if (block) {
        const t = (block.textContent || "").replace(/\u00a0/g, " ").toLowerCase();
        return /нет\s+в\s+наличии/.test(t);
      }
    } catch {}
    return false;
  }

  // Ресейл: блок «ресейл · товары от частных лиц» на странице карточки.
  // У WB класс hashed-хвостом (resaleSummaryCardBadge--_pUAo меняется от сборки
  // к сборке) → ищем по стабильному data-testid, страховка — по тексту.
  function cardIsResale() {
    try {
      const el = document.querySelector('[data-testid="resale-summary-card-badge"]');
      if (el) return true;
      const alt = document.querySelector('[class*="resaleSummaryCardBadge"]');
      if (alt) return /ресейл/i.test(alt.textContent || "");
    } catch {}
    return false;
  }

  // Бейджи карточки товара: карусель div.badges--* → div.mo-badge → span (без data-testid).
  function collectCardBadges() {
    const out = [];
    const blocks = document.querySelectorAll('[class*="badges--"]');
    for (const b of blocks) {
      for (const el of b.querySelectorAll(".mo-badge, [class*='badge--']")) {
        const t = clean(el.textContent || "");
        if (t && t.length <= 40 && !/https?:/i.test(t) && !out.includes(t)) out.push(t);
      }
      break;   // берём только первый блок — свой, не из рекомендаций
    }
    return out;
  }

  // Базовая (видимая) часть карточки — без скролла и без кликов.
  function extractVisible(nmId) {
    const result = {
      nm_id: nmId, title: "", description: "", characteristics: [], recommendations: [],
      url: location.href, brand: "", seller: "", price: 0, old_price: 0, images: [],
      rating: 0, feedbacks: 0, questions: 0, badges: [],
    };

    const h2 = document.querySelector('h2[class*="productTitle"]');
    if (h2) result.title = clean(h2.textContent);

    const brandSpan = document.querySelector('span[class*="productHeaderBrandText"]');
    if (brandSpan) result.brand = clean(brandSpan.textContent);

    const sellerEl = document.querySelector('[class*="sellerInfoNameDefaultText"]');
    if (sellerEl) result.seller = clean(sellerEl.textContent);

    // «Нет в наличии» проверяем ДО поиска цены: при sold-out запасной поиск
    // «N ₽» ловит цену офферов реселлеров («Все N предложений от 2 975 ₽»),
    // а цены WB у распроданного товара нет — пишем 0 и не ищем вовсе.
    result.sold_out = cardSoldOut();
    if (result.sold_out) {
      result.price = 0;
      result.old_price = 0;
    } else {
      const priceEl = findCardPrice();
      if (priceEl) result.price = parseRub(priceEl.textContent);
      const oldEl = findCardOldPrice(priceEl);
      if (oldEl) result.old_price = parseRub(oldEl.textContent);
    }

    result.images = parseImages(nmId);
    Object.assign(result, collectCommonInfo());
    result.badges = allBadges();
    // Ресейл (товар от частного лица) — контент собирать нечего, карточку
    // исключаем из сбора (сервер поставит is_hidden).
    result.is_resale = cardIsResale();
    return result;
  }

  async function extract(nmId) {
    const result = {
      nm_id: nmId, title: "", description: "", characteristics: [], recommendations: [],
      url: location.href, brand: "", seller: "", price: 0, old_price: 0, images: [],
      rating: 0, feedbacks: 0, questions: 0, badges: [],
    };

    const h2 = document.querySelector('h2[class*="productTitle"]');
    if (h2) result.title = h2.textContent.trim();

    const brandSpan = document.querySelector('span[class*="productHeaderBrandText"]');
    if (brandSpan) result.brand = brandSpan.textContent.trim();

    const sellerEl = document.querySelector('[class*="sellerInfoNameDefaultText"]');
    if (sellerEl) result.seller = sellerEl.textContent.trim();

    // «Нет в наличии» проверяем ДО поиска цены (см. extractVisible): иначе
    // фолбэк «N ₽» записывает цену офферов реселлеров вместо отсутствующей цены WB.
    result.sold_out = cardSoldOut();
    if (result.sold_out) {
      result.price = 0;
      result.old_price = 0;
    } else {
      const priceEl = findCardPrice();
      if (priceEl) result.price = parseRub(priceEl.textContent);
      const oldEl = findCardOldPrice(priceEl);
      if (oldEl) result.old_price = parseRub(oldEl.textContent);
    }

    const miniSwiper = document.querySelector('[class*="miniaturesSwiper"]');
    if (miniSwiper) {
      result.images = [...miniSwiper.querySelectorAll('[class*="miniatureSlide"] img')]
        .map((img) => img.src)
        .filter((src) => src && src.includes("c246x328"));
    }
    if (!result.images.length) result.images = parseImages(nmId);

    // рейтинг / оценки / вопросы / бейджи акций — из productCommonInfo--XMAON
    Object.assign(result, collectCommonInfo());
    result.badges = allBadges();
    // Ресейл (товар от частного лица) — описания там нет, парсить нечего.
    result.is_resale = cardIsResale();

    // «Все характеристики и описание» — выдвижной drawer (ленивый). Открываем, только
    // если блока ещё нет. ВАЖНО: closeButton НЕ жмём — на новом WB эта кнопка закрывает
    // саму карточку/модалку, из-за этого вкладка «схлопывалась» сразу после сбора.
    const descBtn = findDetailButton();
    if (descBtn) {
      const descSection = document.querySelector("#section-description");
      if (!descSection || !visible(descSection)) {
        descBtn.click();
        // ждём отрисовки drawer'а (таблицы хар-к + описание) вместо фиксированной паузы
        for (let i = 0; i < 25; i++) {
          await delay(200);
          const s = document.querySelector("#section-description");
          if (s && visible(s)) break;
        }
        await delay(300);
      }
    }

    result.description = parseDescription();
    result.characteristics = parseCharacteristics();

    // рекомендации
    result.recommendations = parseRecommendations(nmId);

    const secsChar = collectCharSections();
    console.log(`[WB-CMS v${VER}]`, {
      nm: result.nm_id,
      desc: result.description.length,
      chars: result.characteristics.length,
      charNames: result.characteristics.slice(0, 8).map((c) => c.name),
      secChar: secsChar.length,
      secDesc: !!findDescSection(),
      recs: result.recommendations.length,
      imgs: result.images.length,
      rating: result.rating,
      feedbacks: result.feedbacks,
      questions: result.questions,
      price: result.price,
      sold_out: result.sold_out,
    });

    // Диагностика. ВАЖНО: content script живёт в изолированном мире, поэтому
    // window.__wbCmsDiag из консоли страницы НЕ виден. Кладём те же данные в DOM:
    //   JSON.parse(document.getElementById('__wb_cms_diag').textContent)
    const secChar = secsChar[0] || null;
    const secDesc = findDescSection();
    const diag = {
      at: new Date().toISOString(),
      ver: VER,
      nm: result.nm_id,
      desc_len: result.description.length,
      chars_cnt: result.characteristics.length,
      char_names: result.characteristics.slice(0, 10).map((c) => c.name),
      recs_cnt: result.recommendations.length,
      recs_sample: result.recommendations.slice(0, 5),
      imgs_cnt: result.images.length,
      imgs_sample: result.images.slice(0, 5),
      char_sections_cnt: secsChar.length,
      char_sections: secsChar.slice(0, 8).map((el) => ({
        tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 120), len: (el.innerText || "").length,
      })),
      has_char_section: !!secChar,
      char_section: secChar
        ? { tag: secChar.tagName, id: secChar.id, cls: String(secChar.className).slice(0, 200) }
        : null,
      has_desc_section: !!secDesc,
      char_html: secChar ? secChar.outerHTML.slice(0, 6000) : "",
      desc_html: secDesc ? secDesc.outerHTML.slice(0, 2000) : "",
      sections: [...document.querySelectorAll("[id^='section']")]
        .slice(0, 20)
        .map((e) => ({ id: e.id, cls: String(e.className).slice(0, 120), len: (e.innerText || "").length })),
      data_tags: [...new Set([...document.querySelectorAll("[data-tag]")].map((e) => e.getAttribute("data-tag")))].slice(0, 50),
      probe: {
        catalog_anchors: document.querySelectorAll('a[href*="/catalog/"]').length,
        detail_anchors: [...document.querySelectorAll('a[href*="/catalog/"]')]
          .filter((a) => /\/catalog\/\d+\/detail/i.test(a.href)).length,
        nm_imgs: [...document.querySelectorAll("img")]
          .filter((i) => String(i.currentSrc || i.src || "").includes(`/${result.nm_id}/images/`)).length,
      },
      payload: result,
    };
    window.__wbCmsDiag = diag;
    try {
      let node = document.getElementById("__wb_cms_diag");
      if (!node) {
        node = document.createElement("script");
        node.type = "application/json"; // не исполняется, CSP не мешает
        node.id = "__wb_cms_diag";
        (document.body || document.documentElement).appendChild(node);
      }
      node.textContent = JSON.stringify(diag);
      document.documentElement.setAttribute("data-wb-cms", VER);
    } catch (e) {
      console.warn("[WB-CMS] diag dom failed:", e);
    }
    return result;
  }

  // Попросить content_shelf.js пересканировать DOM и отправить полки СРАЗУ.
  // Без этого вкладка закрывается (background закрывает её сразу после отчёта
  // о сборе) раньше, чем уйдёт отправка с подписями блоков и фото — полки
  // приходили без них.
  async function rescanShelves() {
    try {
      if (!window.__WB_SHELF_READY__) return; // content_shelf.js не загружен
    } catch {
      return;
    }
    let done = false;
    const onDone = () => {
      done = true;
      try {
        window.removeEventListener("wbcm-shelf-scan-done", onDone);
      } catch {}
    };
    try {
      window.addEventListener("wbcm-shelf-scan-done", onDone);
      window.dispatchEvent(new CustomEvent("wbcm-shelf-scan"));
    } catch {
      return;
    }
    for (let i = 0; i < 40 && !done; i++) await delay(100);
    try {
      window.removeEventListener("wbcm-shelf-scan-done", onDone);
    } catch {}
  }

  async function scrollToBottom() {
    let prevH = 0;
    for (let i = 0; i < 15; i++) {
      // Страница «ничего не найдено»: скроллить нечего, снизу — карусели
      // рекомендаций, которые подгружаются лениво (страница не «кончается»
      // и мы ездили туда-сюда до 25 секунд на каждую битую карточку).
      if (notFoundBlock()) {
        window.scrollTo(0, 0);
        return;
      }
      window.scrollBy(0, 800);
      await delay(400);
      const curH = document.documentElement.scrollHeight;
      if (curH === prevH && i > 3) break;
      prevH = curH;
    }
    window.scrollTo(0, 0);
    await delay(500);
  }

  async function waitForElement(selector, maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await delay(300);
    }
    return null;
  }

  // === Кнопка «Собрать в WB CMS» + авто-capture (Ш8) ===
  // Кэш первичного прогона — 15 мин: повторный клик не скроллит страницу заново.
  const CAP_TTL_MS = 15 * 60 * 1000;
  let lastRun = { nm: null, at: 0, data: null };
  let ui = null;

  const capKey = (nm) => "wbcms:cap:" + nm;
  function loadCapState(nm) {
    try { return JSON.parse(sessionStorage.getItem(capKey(nm)) || "null"); } catch { return null; }
  }
  function saveCapState(nm, st) {
    try { sessionStorage.setItem(capKey(nm), JSON.stringify(st)); } catch {}
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

  // Shadow DOM: стили WB не ломают кнопку, наши — не текут на страницу.
  function mountUI() {
    if (!document.body) return;
    const old = document.getElementById("wbcms-fab-host");
    if (old) old.remove();
    // Кнопка карточки — только на странице товара: на выдаче она перекрывает
    // кнопку «Собрать выдачу» (content_search.js). WB ходит между ними
    // без перезагрузки (SPA), поэтому селекты по URL и в mountUI, и в watcher.
    if (!nmFromPath()) return;
    const host = document.createElement("div");
    host.id = "wbcms-fab-host";
    // Левый верхний угол (под липкой шапкой WB); правый низ занят кнопкой «В корзину».
    host.style.cssText = "position:fixed;left:12px;top:96px;z-index:2147483000;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .wrap{display:flex;gap:6px;align-items:stretch}
        .btn{border:0;border-radius:10px;padding:9px 14px;font:600 12px/1.2 'Segoe UI',Arial,sans-serif;color:#fff;background:#cb11ab;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.18)}
        .btn:disabled{opacity:.75;cursor:default}
        .btn.ok{background:#2e7d32}
        .btn.own{background:#6b7280}
        .btn.err{background:#c62828}
        .re{border:0;border-radius:10px;padding:0 11px;background:#fff;color:#cb11ab;font-size:15px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.18)}
        .hint{margin-top:4px;font:400 10px/1.3 'Segoe UI',Arial,sans-serif;color:#6b7280;text-align:left;max-width:240px}
      </style>
      <div>
        <div class="wrap">
          <button class="btn" id="cap">Собрать в WB CMS</button>
          <button class="re" id="re" title="Пересобрать (игнорировать кэш 24 ч)">↻</button>
        </div>
        <div class="hint" id="hint"></div>
      </div>`;
    document.body.appendChild(host);
    ui = {
      btn: shadow.getElementById("cap"),
      re: shadow.getElementById("re"),
      hint: shadow.getElementById("hint"),
    };
    // В режиме автосбора (вкладку открыло расширение) кнопка не нужна:
    // человек ничего не должен нажимать, а плашка «Ваша карточка» только
    // сбивала с толку. Прячем её.
    try {
      Promise.resolve(sendBG({ type: "WB_MODE" })).then((res) => {
        if (res && res.mode === "full") host.style.display = "none";
      });
    } catch {}
    ui.btn.addEventListener("click", () => {
      const nm = nmFromPath();
      if (!nm) return;
      const st = loadCapState(nm);
      if (st && st.reason === "own_card") {
        if (!confirm("Это ваша карточка. Точно собрать её в базу конкурентов?")) return;
        runCapture({ force: true, allow_own: true });
      } else {
        runCapture({ force: false });
      }
    });
    ui.re.addEventListener("click", () => runCapture({ force: true }));
  }

  function setUI(state, text, hint) {
    if (!ui) return;
    ui.btn.className = "btn" + (state ? " " + state : "");
    ui.btn.disabled = state === "busy";
    if (text) ui.btn.textContent = text;
    if (hint !== undefined) ui.hint.textContent = hint || "";
  }

  function renderCapState() {
    const nm = nmFromPath();
    if (!nm) { setUI("", "Собрать в WB CMS", "не карточка WB"); return; }
    const st = loadCapState(nm);
    if (!st) { setUI("", "Собрать в WB CMS", "контент → общая база конкурентов"); refreshExcludedUI(nm); return; }
    if (st.reason === "own_card") {
      setUI("own", "Ваша карточка", "клик — всё равно собрать");
    } else if (st.reason === "fresh") {
      setUI("ok", "Уже собрано", `${st.at ? agoText(st.at) : ""} · ↻ — пересобрать`);
    } else if (st.reason === "saved") {
      setUI("ok", "Сохранено", `${st.desc || 0} симв. описания, ${st.chars || 0} хар-к · ${agoText(st.at)}`);
    } else {
      setUI("", "Собрать в WB CMS", "");
    }
    refreshExcludedUI(nm);
  }

  // Исключена ли карточка из сбора для нашей компании? — узнаём у сервера (§19.4).
  // Локальный sessionStorage для этого не годится: он заполняется только ПОСЛЕ
  // ответа сервера, то есть уже после того, как карточку открыли и прокрутили.
  async function askCapState(nm) {
    if (!nm) return null;
    const res = await sendBG({ type: "CAP_STATE", nm_id: Number(nm) || 0 });
    return res || null;
  }

  async function refreshExcludedUI(nm) {
    try {
      const st = await askCapState(nm);
      if (!st || !st.hidden) return false;
      setUI("err", "Исключено — не собираем", "вернуть: «Собранные карточки» на сайте");
      return true;
    } catch {
      return false;
    }
  }

  function applyCaptureResult(nm, res) {
    if (!res || !res.ok) {
      setUI("err", "Ошибка", (res && res.error) || "нет связи с сервером");
      return;
    }
    const r = res.result || {};
    if (r.skipped && r.reason === "own_card") {
      saveCapState(nm, { at: new Date().toISOString(), reason: "own_card" });
      renderCapState();
      return;
    }
    if (r.skipped && r.reason === "fresh") {
      saveCapState(nm, { at: r.collected_at || new Date().toISOString(), reason: "fresh" });
      renderCapState();
      return;
    }
    if (r.skipped && r.reason === "hidden") {
      setUI("err", "Исключено — не собираем", "вернуть: «Собранные карточки» на сайте");
      return;
    }
    saveCapState(nm, {
      at: new Date().toISOString(), reason: "saved",
      desc: r.desc_len || 0, chars: r.chars_cnt || 0,
    });
    renderCapState();
  }

  function sendBG(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || null); });
      } catch { resolve(null); }
    });
  }

  // Кто мы: вкладка расширения (очередь/поиск) или вкладка человека (фоновый режим).
  async function askMode() {
    const res = await sendBG({ type: "WB_MODE" });
    return (res && res.mode) || "passive";
  }

  async function runCapture({ force = false, allow_own = false } = {}) {
    const nm = nmFromPath();
    if (!nm || running) return null;
    running = true;
    try {
      if (captchaReason()) { await reportCaptcha("manual"); return null; }
      captchaSent = false;
      // Исключена из сбора для нашей компании? — не скроллим и не собираем:
      // сервер всё равно откажет («hidden»), а скролл уже потратил бы время.
      if (await refreshExcludedUI(nm)) return null;
      let data = null;
      if (!force && lastRun.nm === nm && lastRun.data && Date.now() - lastRun.at < CAP_TTL_MS) {
        data = lastRun.data;
      } else {
        setUI("busy", "Собираю…", "скроллю страницу…");
        const app = await waitForApp(10000);
        if (cardNotFound(app)) {
          setUI("err", "Карточка не найдена", "WB: «По Вашему запросу ничего не найдено»");
          return null;
        }
        await waitForElement('h2[class*="productTitle"]', 15000);
        await scrollToBottom();
        if (cardNotFound(currentApp())) {
          setUI("err", "Карточка не найдена", "WB: «По Вашему запросу ничего не найдено»");
          return null;
        }
        await waitForElement(".cards-list__container", 5000);
        window.scrollTo(0, 0);
        await delay(800);
        if (captchaReason()) { await reportCaptcha("manual"); return null; }
        data = await extract(nm);
        lastRun = { nm, at: Date.now(), data };
      }
      setUI("busy", "Сохраняю…", "");
      const res = await sendBG({ type: "CAPTURE", data, force, allow_own });
      applyCaptureResult(nm, res);
      return res;
    } catch (e) {
      if (captchaReason()) { await reportCaptcha("manual"); return null; }
      console.error("[WB-CMS] capture failed:", e);
      setUI("err", "Ошибка", String((e && e.message) || e).slice(0, 80));
      return null;
    } finally {
      running = false;
    }
  }

  // Запросы из popup работают с активной вкладкой (§8.6).
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "WB_RUN_CAPTURE") {
        runCapture({ force: !!msg.force }).then((res) => sendResponse({ ok: true, res }));
        return true;
      }
      if (msg.type === "WB_CAP_STATE") {
        const nm = nmFromPath();
        sendResponse({ nm, state: loadCapState(nm) });
        return true;
      }
    });
  } catch {}

  // Фоновая вкладка: Chrome режет таймеры (≥1 с), а WB лениво рендерит описание и
  // рекомендации только когда вкладку показали. Поэтому ждём видимость, а не собираем мусор.
  function whenVisible() {
    return new Promise((resolve) => {
      if (document.visibilityState !== "hidden") return resolve();
      const onVis = () => {
        if (document.visibilityState === "hidden") return;
        document.removeEventListener("visibilitychange", onVis);
        resolve();
      };
      document.addEventListener("visibilitychange", onVis);
    });
  }

  // ===================== ПАССИВНЫЙ РЕЖИМ (фон) =====================
  // Ничего не скроллим и не открываем сами — пишем только то, что человек уже открыл:
  //   базовая часть карточки → открытое описание → долистанные рекомендации.
  let passiveTimer = null;
  const passiveSeen = { desc: false, recs: false, imgs: 0 };

  function obsKey(data) {
    return [data.price, data.old_price, data.rating, data.feedbacks, data.questions,
      (data.description || "").length, (data.characteristics || []).length,
      (data.recommendations || []).length, (data.badges || []).join("|"),
      (data.images || []).length].join("~");
  }

  async function sendObserve(nm, phase) {
    const data = extractVisible(nm);
    data.phase = phase;
    if (phase === "desc") {
      data.description = parseDescription();
      const chars = parseCharacteristics();
      if (chars.length) data.characteristics = chars;
    }
    if (phase === "recs") {
      data.recommendations = parseRecommendations(nm);
    }
    const key = phase + "|" + obsKey(data);
    if (passiveSeen[phase] === key) return;   // ничего не изменилось — не шлём
    passiveSeen[phase] = key;
    console.log(`[WB-CMS] observe ${phase}`, {
      nm, price: data.price, old: data.old_price, desc: (data.description || "").length,
      chars: (data.characteristics || []).length, recs: (data.recommendations || []).length,
      rating: data.rating, fb: data.feedbacks, q: data.questions, badges: data.badges,
      sold_out: data.sold_out,
    });
    await sendBG({ type: "WB_OBSERVE_CARD", data });
  }

  function stopPassive() {
    if (passiveTimer) { clearInterval(passiveTimer); passiveTimer = null; }
  }

  async function runPassive(nm) {
    stopPassive();
    passiveSeen.desc = false;
    passiveSeen.recs = false;
    passiveSeen.imgs = 0;
    // Исключена из сбора для нашей компании? — не наблюдаем вовсе (сервер всё
    // равно откажет, а парсить описание и картинки — работа впустую).
    try {
      const st = await askCapState(nm);
      if (st && st.hidden) {
        console.log("[WB-CMS] карточка исключена из сбора — наблюдение пропущено");
        return;
      }
    } catch {}
    await waitForElement('h2[class*="productTitle"]', 8000);
    if (captchaReason()) { await reportCaptcha("passive"); return; }
    // базовое — сразу (то, что видно без скролла)
    await sendObserve(nm, "base");
    passiveSeen.imgs = parseImages(nm).length;

    // следим: человек открыл описание / долистал до рекомендаций
    passiveTimer = setInterval(async () => {
      if (running) return;
      try {
        // Галерея WB дорендеривается лениво: миниатюр стало больше — до-наблюдаем,
        // иначе в деталях останется одно превью вместо полного набора.
        const imgs = parseImages(nm).length;
        if (imgs > passiveSeen.imgs) {
          passiveSeen.imgs = imgs;
          await sendObserve(nm, "base");
        }
        if (!passiveSeen.desc) {
          const sec = findDescSection();
          if (sec && visible(sec)) {
            passiveSeen.desc = true;      // дальше только по изменению содержимого
            await sendObserve(nm, "desc");
          }
        }
        if (!passiveSeen.recs) {
          const recs = document.querySelector(".cards-list__container");
          if (recs && visible(recs)) {
            passiveSeen.recs = true;
            await sendObserve(nm, "recs");
          }
        }
      } catch (e) {
        console.warn("[WB-CMS] observe tick failed:", e);
      }
    }, 1500);
  }

  // ===================== ПОЛНЫЙ РЕЖИМ (очередь расширения) =====================
  // Сбор не удался: репортим на сервер (/api/ext/error через background), иначе
  // строка очереди висит в processing до 30-минутного таймаута. Вызывается только
  // после повторной попытки (WB иногда дорисовывает страницу со второго прохода).
  // WB-страница «По Вашему запросу ничего не найдено» — карточки нет.
  // Раньше ждали отрисовки 2×15 сек и всё равно упирались в пустую страницу.
  // Блок WB «По Вашему запросу ничего не найдено» — самый надёжный признак:
// проверка по DOM (быстро, не трогает layout), в отличие от текста.
// Скрытый шаблон WB (есть в DOM каждой страницы) не считаем — блок должен
// быть видимым и содержать именно надпись о пустой выдаче.
function notFoundBlock() {
  try {
    const el = document.querySelector(".content404");
    if (!el) return false;
    const rects = el.getClientRects();
    if (!rects || !rects.length) return false;
    const t = (el.textContent || "").replace(/\u00a0/g, " ").toLowerCase();
    return t.includes("ничего не найдено") || t.includes("не нашлось подходящих");
  } catch {
    return false;
  }
}

// ГЛАВНЫЙ ПРИЗНАК «карточки нет» — приложение WB: SPA монтируется в
  // #reactContainers и пишет в data-current-app, что сейчас на экране:
  //   error404                 — товара нет («По Вашему запросу ничего не найдено»)
  //   SpaProductCardEntrypoint — карточка товара
  // Ждём этот блок и сразу решаем: скроллить карточку или выходить, не «ловия»
  // дальше по DOM (текст/селекторы) — вёрстка WB меняется, признак — нет.
  const APP_ERROR_404 = "error404";
  const APP_PRODUCT_CARD = "SpaProductCardEntrypoint";

  function currentApp() {
    try {
      const el = document.getElementById("reactContainers");
      return el ? String(el.getAttribute("data-current-app") || "") : "";
    } catch {
      return "";
    }
  }

  // Значение может проставиться с задержкой и смениться (карточка → error404),
  // поэтому ждём, пока оно перестанет меняться (APP_STABLE_MS).
  const APP_STABLE_MS = 800;
  async function waitForApp(maxMs = 15000) {
    const start = Date.now();
    let last = "";
    let since = Date.now();
    while (Date.now() - start < maxMs) {
      const cur = currentApp();
      if (cur !== last) {
        last = cur;
        since = Date.now();
      } else if (cur && Date.now() - since >= APP_STABLE_MS) {
        return cur;
      }
      await delay(300);
    }
    return last;
  }

  function cardNotFound(app) {
    // Основной признак — приложение WB; страховка — видимый блок пустой выдачи.
    if (app) return app === APP_ERROR_404;
    return notFoundBlock();
  }

  async function reportCollectError(nm, reason, notFound = false) {
    console.error(`[WB-CMS] enrich error nm ${nm}: ${reason} — репортим на сервер`);
    if (ui) setUI("err", "Сбор не удался", String(reason).slice(0, 80));
    const data = { nm_id: nm, error: reason };
    // «Карточки нет на WB»: WB отдал error404/content404 — сервер ставит
    // статус 'gone' (не отдаётся в обновление до ручной проверки «Появилась»)
    if (notFound) data.reason = "not_found";
    await sendBG({ type: "WB_ENRICH_ERROR", data });
  }

  async function run() {
    const nm = nmFromPath();
    if (!nm || running) return;
    running = true;
    try {
      if (captchaReason()) { await reportCaptcha("enrich"); return; }
      captchaSent = false;
      await whenVisible();
      if (captchaReason()) { await reportCaptcha("enrich"); return; }

      // 1) Ждём приложение WB (#reactContainers[data-current-app]) и сразу
      //    решаем: error404 — товара нет, выходим, не скроллим.
      const app = await waitForApp(15000);
      if (cardNotFound(app)) {
        console.warn(`[WB-CMS] ${nm}: WB не нашла товар (app=${app || "error404"})`);
        await reportCollectError(nm, "карточка не найдена на WB", true);
        return;
      }
      if (app && app !== APP_PRODUCT_CARD) {
        // WB поменял имя приложения — собираем как карточку, но помечаем в логе.
        console.warn(`[WB-CMS] ${nm}: незнакомое приложение WB (${app}) — собираю как карточку`);
      }

      // Сбор с одной повторной попыткой: пустышку на сервер не шлём сразу —
      // в базу уехала бы карточка без описания/характеристик. Ошибка репортится
      // только если пусто/сломалось и на 2-й попытке.
      let data = null;
      let lastErr = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // Ждём заголовок карточки, но «ничего не найдено» ловим сразу,
          // не дожидаясь 15 секунд: надпись у WB дорисовывается позже, поэтому
          // одноразовая проверка её могла пропустить.
          let notFound = false;
          let hasTitle = false;
          for (let waited = 0; waited < 15000; waited += 300) {
            if (cardNotFound(currentApp())) { notFound = true; break; }
            if (document.querySelector('h2[class*="productTitle"]')) { hasTitle = true; break; }
            await delay(300);
          }
          // Заголовка карточки нет и за 15 секунд — карточки тоже нет
          // (WB на такой отдаёт «По Вашему запросу ничего не найдено»).
          // Без этой проверки мы уходили в скролл и «ездили туда-сюда».
          if (!notFound && !hasTitle) notFound = true;
          if (notFound) {
            console.warn(`[WB-CMS] карточка ${nm} не найдена на WB — выходим сразу`);
            await reportCollectError(nm, "карточка не найдена на WB", true);
            return;
          }
          // Даём WB время дорисовать страницу: сразу после появления заголовка
          // она ещё «пустая» — ранний скролл улетает вверх, лента не подгружается
          // и описание/рекомендации остаются неполными.
          await delay(1000);
          await scrollToBottom();
          // Полки (с подписями и фото) — отправляем сейчас, до скролла наверх:
          // вкладку закроют сразу после отчёта о сборе.
          await rescanShelves();
          if (cardNotFound(currentApp())) {
            await reportCollectError(nm, "карточка не найдена на WB", true);
            return;
          }
          await waitForElement(".cards-list__container", 5000);
          window.scrollTo(0, 0);
          await delay(1000);
          if (captchaReason()) { await reportCaptcha("enrich"); return; }
          data = await extract(nm);
          if (data.description || data.characteristics.length) break;
          lastErr = "страница не дорисовалась (пустой сбор)";
        } catch (e) {
          if (captchaReason()) { await reportCaptcha("enrich"); return; }
          lastErr = String((e && e.message) || e).slice(0, 120);
          data = null;
        }
        if (attempt < 2) {
          console.warn(`[WB-CMS] попытка ${attempt} не удалась (${lastErr}) — retry через 5с`);
          await delay(5000);
        }
      }
      if (!data || (!data.description && !data.characteristics.length)) {
        await reportCollectError(nm, lastErr || "empty collect");
        return;
      }
      lastRun = { nm, at: Date.now(), data };

      const res = await sendBG({ type: "WB_RESULT", data });
      if (res && res.status === 200) {
        saveCapState(nm, {
          at: new Date().toISOString(), reason: "saved",
          desc: data.description.length, chars: data.characteristics.length,
        });
        renderCapState();
      } else if (res && res.captured) {
        applyCaptureResult(nm, res.captured);
      } else if (res && res.status === 403) {
        setUI("", "Собрать в WB CMS", "не в очереди — соберу в общую базу");
      } else if (res && res.error) {
        setUI("err", "Ошибка", String(res.error).slice(0, 80));
      }
    } catch (e) {
      if (captchaReason()) { await reportCaptcha("enrich"); return; }
      console.error("[WB-CMS] collect failed:", e);
    } finally {
      running = false;
    }
  }

  // SPA: WB умеет менять nm без перезагрузки — иначе всегда собиралась бы первая карточка.
  // Заодно возвращаем кнопку, если WB перерисовал body. Кнопка карточки и кнопка
  // выдачи живут на одном месте — показываем свою только на странице товара,
  // иначе на выдаче она перекрывает «Собрать выдачу» (content_search.js).
  setInterval(async () => {
    const fab = document.getElementById("wbcms-fab-host");
    if (nmFromPath()) {
      if (!fab && document.body) {
        mountUI();
        renderCapState();
      }
    } else if (fab) {
      fab.remove();
    }
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    renderCapState();
    const nm = nmFromPath();
    if (!nm) { stopPassive(); return; }
    const mode = await askMode();
    if (mode === "full") {
      run();
    } else {
      setTimeout(() => runPassive(nm), 800);
    }
  }, 1000);

  mountUI();
  renderCapState();
  (async () => {
    const nm = nmFromPath();
    if (!nm) return;
    const mode = await askMode();
    if (mode === "full") {
      run();
    } else {
      runPassive(nm);
    }
  })();
})();
