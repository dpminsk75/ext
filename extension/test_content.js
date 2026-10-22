(() => {
  const nmMatch = location.pathname.match(/\/catalog\/(\d+)\/detail/);
  if (!nmMatch) return;
  const nmId = parseInt(nmMatch[1]);

  async function scrollToBottom() {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    let prevH = 0;
    for (let i = 0; i < 20; i++) {
      window.scrollBy(0, 800);
      await delay(400);
      const curH = document.documentElement.scrollHeight;
      if (curH === prevH && i > 3) break;
      prevH = curH;
    }
    window.scrollTo(0, 0);
    await delay(500);
  }

  async function clickDescriptionButton() {
    const btn = document.querySelector('button[class*="btnDetail"]');
    if (btn) {
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  function collectDiagnostics() {
    const d = { nm_id: nmId, url: location.href, type: "WB_DIAG" };

    d.h2 = [...document.querySelectorAll("h2")].map(el => ({
      text: el.textContent.trim().slice(0, 80),
      class: el.className
    }));

    d.dataTags = [...document.querySelectorAll("[data-tag]")].map(el => ({
      tag: el.getAttribute("data-tag"),
      tagN: el.tagName,
      class: el.className?.split(" ")[0] || "",
      text: el.textContent.trim().slice(0, 120)
    }));

    d.sections = [...document.querySelectorAll("section[id]")].map(el => ({
      id: el.id,
      class: el.className.slice(0, 100),
      text: el.textContent.trim().slice(0, 150)
    }));

    // catalog links — конкуренты
    d.catalogLinks = [...document.querySelectorAll('a[href*="/catalog/"]')].map(a => {
      const m = a.href.match(/\/catalog\/(\d+)/);
      return {
        nmId: m ? parseInt(m[1]) : null,
        class: a.className?.split(" ")[0] || "",
        parentClass: a.parentElement?.className?.split(" ")[0] || ""
      };
    }).filter(l => l.nmId && l.nmId !== nmId);

    // popup cards
    d.popupCards = [...document.querySelectorAll("[data-popup-nm-id]")].map(el => ({
      nmId: el.getAttribute("data-popup-nm-id"),
      tag: el.tagName,
      class: el.className?.split(" ")[0] || "",
      parentClass: el.parentElement?.className?.split(" ")[0] || ""
    }));

    // brand + seller — h2.sellerAndBrandItemName
    const brandH2 = document.querySelector('h2[class*="sellerAndBrandItemName"]');
    d.brand = brandH2?.textContent?.trim() || "";

    // альтернативно: a.productHeaderBrand
    if (!d.brand) {
      const brandA = document.querySelector('a[class*="productHeaderBrand"]');
      d.brand = brandA?.querySelector("span")?.textContent?.trim() || "";
    }

    // seller — ищем отдельно
    const sellerEls = document.querySelectorAll('h2[class*="sellerAndBrandItemName"]');
    d.seller = sellerEls.length > 1 ? sellerEls[1].textContent.trim() : "";

    // images
    d.images = [...document.querySelectorAll('[class*="miniaturesWrapper"] img, .swiper-wrapper img')].map(img => ({
      src: img.src,
      alt: img.alt?.slice(0, 60) || ""
    }));

    // description
    const descSection = document.querySelector("#section-description");
    d.descriptionSection = {
      exists: !!descSection,
      visible: descSection ? descSection.offsetParent !== null : false,
      text: descSection?.textContent?.trim()?.slice(0, 300) || "",
    };

    // chars
    const charsSection = document.querySelector("#section-characteristics");
    d.charsSection = {
      exists: !!charsSection,
      text: charsSection?.textContent?.trim()?.slice(0, 300) || ""
    };

    // desc buttons
    d.descButtons = [...document.querySelectorAll("button")].filter(b =>
      /описани|характеристик/i.test(b.textContent)
    ).map(b => ({
      text: b.textContent.trim().slice(0, 60),
      class: b.className?.split(" ")[0] || ""
    }));

    // meta
    const metaDesc = document.querySelector('meta[name="description"]');
    d.metaDescription = metaDesc?.content?.slice(0, 200) || null;
    d.pageTitle = document.title;

    return d;
  }

  (async () => {
    await scrollToBottom();
    await clickDescriptionButton();
    const diag = collectDiagnostics();
    // Отправляем через background.js (обход Mixed Content)
    chrome.runtime.sendMessage({ type: "WB_DIAG", data: diag });
    console.log("[DIAG]", JSON.stringify(diag, null, 2));
  })();
})();
