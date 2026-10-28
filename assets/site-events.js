(() => {
  const siteOrigin = "https://cooleryu.github.io";
  const sitePath = "/ContextAdapt/";
  const currentPage = new URL(window.location.href);
  if (currentPage.origin !== siteOrigin || !currentPage.pathname.startsWith(sitePath)) return;
  if (window.contextAdaptEventsInstalled) return;
  window.contextAdaptEventsInstalled = true;

  const pageData = { content_language: document.documentElement.lang || "und" };
  // Use the page's canonical path so a missing article served by 404.html
  // does not become an article view. Language variants share the same slug.
  const canonical = document.querySelector('link[rel="canonical"]');
  let article;
  let entryPage = currentPage.pathname;
  try {
    const url = new URL(canonical?.href);
    if (url.origin === siteOrigin && url.pathname.startsWith(sitePath)) {
      entryPage = url.pathname;
      article = url.pathname.match(/^\/ContextAdapt\/articles\/([^/]+)(?:\/|$)/);
    }
  } catch {
    // A page without a valid canonical URL is not classified as an article.
  }
  if (article) pageData.article_id = article[1];

  // This is a tab-local, 30-minute entry context, not an Umami visit or ID.
  // The fixed UTM allowlist avoids collecting arbitrary query-string text.
  const sources = new Set(["github", "google", "bing", "chatgpt", "perplexity", "claude",
    "gemini", "doubao", "deepseek", "kimi", "qwen", "hunyuan", "baidu", "x", "twitter",
    "reddit", "wechat", "zhihu", "newsletter"]);
  const utm = (currentPage.searchParams.get("utm_source") || "").toLowerCase();
  const entryUtmSource = sources.has(utm) ? utm : undefined;
  let referrerSource = "unknown";
  let internalReferrer = false;
  try {
    const referrer = new URL(document.referrer);
    if (["http:", "https:"].includes(referrer.protocol)) {
      internalReferrer = referrer.origin === siteOrigin && referrer.pathname.startsWith(sitePath);
      if (!internalReferrer) referrerSource = referrer.hostname;
    }
  } catch {
    // Missing referrer is unknown; it is not proof of a direct visit.
  }
  const storageKey = "contextadapt.entry.v1";
  const maxIdle = 30 * 60 * 1000;
  const entryFields = (entry, scope) => ({
    entry_page: entry.entry_page,
    entry_source: entry.entry_source,
    ...(entry.entry_utm_source && { entry_utm_source: entry.entry_utm_source }),
    entry_scope: scope,
    entry_context: JSON.stringify([entry.entry_source, entry.entry_page, scope]),
  });
  const entryContext = (arrival = false) => {
    const now = Date.now();
    const fresh = {
      entry_page: entryPage,
      entry_source: entryUtmSource ? `utm:${entryUtmSource}` : referrerSource,
      ...(entryUtmSource && { entry_utm_source: entryUtmSource }),
      lastAt: now,
    };
    try {
      let saved;
      try {
        saved = JSON.parse(window.sessionStorage.getItem(storageKey));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      const usable = saved && typeof saved.entry_page === "string" &&
        saved.entry_page.startsWith(sitePath) && !/[?#]/.test(saved.entry_page) &&
        typeof saved.entry_source === "string" &&
        /^(unknown|[a-z0-9.-]+|utm:[a-z]+)$/.test(saved.entry_source) &&
        (!saved.entry_utm_source || sources.has(saved.entry_utm_source)) &&
        Number.isFinite(saved.lastAt) && saved.lastAt <= now && now - saved.lastAt < maxIdle;
      // Only an observed internal referral continues an entry on a new page.
      // A missing referrer, external arrival, or recognized UTM starts anew.
      const entry = usable && !(arrival && (!internalReferrer || entryUtmSource))
        ? saved : fresh;
      const stored = { entry_page: entry.entry_page, entry_source: entry.entry_source,
        ...(entry.entry_utm_source && { entry_utm_source: entry.entry_utm_source }), lastAt: now };
      window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
      return entryFields(stored, "tab-30m");
    } catch {
      return entryFields(fresh, "page");
    }
  };
  const initialEntry = entryContext(true);

  const track = (name, data) => {
    if (typeof window.umami?.track !== "function") return;
    try {
      Promise.resolve(window.umami.track(name, data)).catch(() => {});
    } catch {
      // Analytics must never interrupt page use if the tracker is unavailable.
    }
  };

  // This records opening the document, not reading or completing the article.
  if (article) track("article_view", { ...pageData, ...initialEntry });

  const trackRepositoryClick = event => {
    if (event.defaultPrevented) return;
    if (event.type === "click" ? event.button !== 0 : event.button !== 1) return;
    const link = event.target?.closest?.("a[href]") || event.target?.parentElement?.closest?.("a[href]");
    if (!link) return;
    let destination;
    try {
      destination = new URL(link.href);
    } catch {
      return;
    }
    if (destination.origin !== "https://github.com" ||
        !/^\/cooleryu\/ContextAdapt(?:\/|$)/i.test(destination.pathname)) return;
    track("github_click", { ...pageData, ...entryContext(),
      destination: destination.origin + destination.pathname });
  };

  // Separate primary/keyboard clicks from middle clicks; never cancel or
  // replace browser navigation. Umami's API sends with fetch keepalive.
  document.addEventListener("click", trackRepositoryClick, { passive: true });
  document.addEventListener("auxclick", trackRepositoryClick, { passive: true });
})();
