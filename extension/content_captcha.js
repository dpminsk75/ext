(() => {
  // Страховка на случай, если WB редиректит на отдельный антибот-URL,
  // который не совпадает с масками content.js/content_search.js.
  // Сами по себе эти скрипты тоже умеют ловить капчу, здесь — общий случай.
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

  let sent = false;
  function check() {
    if (sent || !captchaReason()) return;
    sent = true;
    try {
      chrome.runtime.sendMessage({
        type: "CAPTCHA",
        data: { url: location.href, where: "page" },
      });
    } catch {}
  }

  let n = 0;
  const timer = setInterval(() => {
    check();
    if (++n >= 30) clearInterval(timer);
  }, 2000);
})();
