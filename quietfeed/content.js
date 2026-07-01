/* =========================================================================
   Quietfeed content script
   - Applies body classes for the CSS-driven "minimal" view.
   - Harvests media/text from the virtualized native feed and repaints it
     into a clean overlay for "pinterest" and "focus" views.
   ========================================================================= */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    hideMetrics: true,
    hideIdentity: true,
    hideText: false,
    hideChrome: true,
    layout: "minimal", // "minimal" | "pinterest" | "focus"
  };

  let cfg = { ...DEFAULTS };

  const root = document.documentElement;

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  function load() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        cfg = { ...DEFAULTS, ...stored };
        resolve();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let touched = false;
    for (const key of Object.keys(DEFAULTS)) {
      if (key in changes) {
        cfg[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched) apply();
  });

  // Allow the popup to nudge us immediately (belt & suspenders).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "quietfeed:refresh") {
      Object.assign(cfg, msg.cfg || {});
      apply();
    }
  });

  // ---------------------------------------------------------------------
  // Apply state
  // ---------------------------------------------------------------------
  function apply() {
    root.classList.toggle("zf-enabled", cfg.enabled);
    root.classList.toggle("zf-hide-metrics", cfg.enabled && cfg.hideMetrics);
    root.classList.toggle("zf-hide-identity", cfg.enabled && cfg.hideIdentity);
    root.classList.toggle("zf-hide-text", cfg.enabled && cfg.hideText);
    root.classList.toggle("zf-hide-chrome", cfg.enabled && cfg.hideChrome);

    root.classList.toggle("zf-mode-minimal", cfg.enabled && cfg.layout === "minimal");
    root.classList.toggle("zf-mode-pinterest", cfg.enabled && cfg.layout === "pinterest");
    root.classList.toggle("zf-mode-focus", cfg.enabled && cfg.layout === "focus");

    const wantOverlay = cfg.enabled && (cfg.layout === "pinterest" || cfg.layout === "focus");
    if (wantOverlay) {
      Overlay.enter();
    } else {
      Overlay.exit();
    }
  }

  // ---------------------------------------------------------------------
  // Harvesting the native feed
  // ---------------------------------------------------------------------
  function upscale(url) {
    if (!url) return url;
    // pbs.twimg.com media: bump the requested size up.
    return url.replace(/([?&]name=)[^&]+/, "$1large");
  }

  function statusId(article) {
    const link = article.querySelector('a[href*="/status/"]');
    const m = link && link.getAttribute("href").match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  // Returns a card model, or null if there's nothing worth showing.
  function extractCard(article) {
    const id = statusId(article);
    if (!id) return null;

    const imgs = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .map((img) => upscale(img.currentSrc || img.src))
      .filter((src) => src && src.includes("pbs.twimg.com/media"));

    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : "";

    // Nothing to admire? (no image, and text is hidden or empty) -> skip.
    if (imgs.length === 0 && (cfg.hideText || !text)) return null;

    return { id, imgs, text };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Find the element X actually scrolls. Usually the document scrolling
  // element, but walk up from the timeline in case it's a nested scroller.
  function getScroller() {
    const col = document.querySelector('[data-testid="primaryColumn"]');
    let node = col ? col.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 40) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // ---------------------------------------------------------------------
  // Overlay controller
  // ---------------------------------------------------------------------
  const Overlay = (() => {
    let el = null; // #zf-overlay
    let stage = null; // #zf-stage
    let sentinel = null;
    let observer = null;
    let io = null; // IntersectionObserver for infinite scroll
    let active = false;

    const seen = new Set();
    const cards = []; // ordered card models
    let focusIndex = 0;
    let loading = false;

    function build() {
      el = document.createElement("div");
      el.id = "zf-overlay";

      const bar = document.createElement("div");
      bar.id = "zf-bar";
      bar.innerHTML = `<span class="zf-brand">Quietfeed</span>`;
      const mk = (label, fn, cls) => {
        const b = document.createElement("button");
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener("click", fn);
        return b;
      };
      const bMin = mk("Minimal", () => setLayout("minimal"));
      const bPin = mk("Pinterest", () => setLayout("pinterest"));
      const bFoc = mk("Focus", () => setLayout("focus"));
      const bText = mk(cfg.hideText ? "Show text" : "Hide text", () => {
        setCfg({ hideText: !cfg.hideText });
      });
      const bMore = mk("Load more", () => pumpUntil(cards.length + 20));
      bMore.className = "zf-more";
      const bOff = mk("Turn off", () => setCfg({ enabled: false }), "zf-off");
      bar._bText = bText;
      bar._bPin = bPin;
      bar._bFoc = bFoc;
      bar._bMore = bMore;
      bar.append(bMin, bPin, bFoc, bText, bMore, bOff);

      stage = document.createElement("div");
      stage.id = "zf-stage";

      sentinel = document.createElement("div");
      sentinel.id = "zf-sentinel";

      el._bar = bar;
      el.append(bar, stage, sentinel);
      document.body.appendChild(el);
    }

    function refreshBar() {
      if (!el) return;
      const bar = el._bar;
      [...bar.querySelectorAll("button")].forEach((b) => b.classList.remove("zf-active"));
      bar._bPin.classList.toggle("zf-active", cfg.layout === "pinterest");
      bar._bFoc.classList.toggle("zf-active", cfg.layout === "focus");
      bar._bText.textContent = cfg.hideText ? "Show text" : "Hide text";
    }

    function setLayout(layout) {
      setCfg({ layout });
    }

    function ingest(article) {
      const card = extractCard(article);
      if (!card || seen.has(card.id)) return;
      seen.add(card.id);
      cards.push(card);
      if (cfg.layout === "pinterest") appendPinterest(card);
      else renderFocus();
      hideEmpty();
    }

    function scanAll() {
      document
        .querySelectorAll('article[data-testid="tweet"]')
        .forEach((a) => ingest(a));
    }

    // ---- rendering ----
    function galleryEl(card, focus) {
      const g = document.createElement("div");
      g.className = "zf-gallery zf-badge";
      if (card.imgs.length > 1) g.setAttribute("data-count", `1/${card.imgs.length}`);
      card.imgs.forEach((src) => {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = src;
        img.referrerPolicy = "no-referrer";
        g.appendChild(img);
      });
      return g;
    }

    function textEl(card) {
      if (cfg.hideText || !card.text) return null;
      const t = document.createElement("div");
      t.className = "zf-text";
      t.textContent = card.text;
      return t;
    }

    function appendPinterest(card) {
      const c = document.createElement("div");
      c.className = "zf-card" + (card.imgs.length === 0 ? " zf-textonly" : "");
      if (card.imgs.length) c.appendChild(galleryEl(card));
      const t = textEl(card);
      if (t) c.appendChild(t);
      stage.appendChild(c);
    }

    function renderPinterestAll() {
      stage.innerHTML = "";
      cards.forEach((card) => appendPinterest(card));
      hideEmpty();
    }

    function renderFocus() {
      if (cfg.layout !== "focus") return;
      stage.innerHTML = "";
      if (!cards.length) {
        showEmpty();
        return;
      }
      hideEmpty();
      focusIndex = Math.max(0, Math.min(focusIndex, cards.length - 1));
      const card = cards[focusIndex];

      const wrap = document.createElement("div");
      wrap.className = "zf-focus-card";
      if (card.imgs.length) wrap.appendChild(galleryEl(card, true));
      const t = textEl(card);
      if (t) wrap.appendChild(t);
      stage.appendChild(wrap);

      const nav = document.createElement("div");
      nav.className = "zf-focus-nav";
      const prev = document.createElement("button");
      prev.textContent = "‹";
      prev.disabled = focusIndex === 0;
      prev.addEventListener("click", () => go(-1));
      const count = document.createElement("span");
      count.className = "zf-count";
      count.textContent = `${focusIndex + 1} / ${cards.length}`;
      const next = document.createElement("button");
      next.textContent = "›";
      next.addEventListener("click", () => go(1));
      nav.append(prev, count, next);
      stage.appendChild(nav);
    }

    function go(delta) {
      focusIndex += delta;
      if (focusIndex >= cards.length - 3) pumpUntil(focusIndex + 10); // prefetch near the end
      renderFocus();
      el.scrollTo({ top: 0 });
    }

    function onKey(e) {
      if (!active || cfg.layout !== "focus") return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(-1); }
    }

    // ---- empty state ----
    function showEmpty() {
      if (el.querySelector("#zf-empty")) return;
      const e = document.createElement("div");
      e.id = "zf-empty";
      e.textContent = "Looking for work to admire… scroll or wait a moment.";
      stage.appendChild(e);
    }
    function hideEmpty() {
      const e = el && el.querySelector("#zf-empty");
      if (e && cards.length) e.remove();
    }

    // ---- keep the (hidden) native feed loading more ----
    function setLoadingUI(on) {
      if (!el) return;
      const b = el._bar && el._bar._bMore;
      if (b) {
        b.textContent = on ? "Loading…" : "Load more";
        b.disabled = on;
      }
    }

    // Drive X's real scroll container to the bottom, in a loop, until we've
    // harvested `target` cards (or the feed stops growing). This is what
    // actually makes X fetch the next page — a single scrollBy isn't enough.
    let pumpTarget = 0;
    async function pumpUntil(target, maxStagnant = 8) {
      pumpTarget = Math.max(pumpTarget, target); // let a running pump absorb new asks
      if (loading || !active) return;
      loading = true;
      setLoadingUI(true);
      try {
        const scroller = getScroller();
        let stagnant = 0;
        while (active && cards.length < pumpTarget && stagnant < maxStagnant) {
          const beforeCards = cards.length;
          const beforeH = scroller.scrollHeight;
          const beforeTop = scroller.scrollTop;

          // Advance in big steps (not a teleport) so X's virtualizer actually
          // renders the tweets we pass — otherwise they're never harvested.
          // Reaching the bottom is what trips X's next-page fetch.
          const step = Math.max(700, scroller.clientHeight * 2.5);
          scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
          window.dispatchEvent(new Event("scroll")); // poke window-scroll listeners too

          await sleep(450);
          scanAll();

          const grew = cards.length > beforeCards || scroller.scrollHeight > beforeH + 20;
          const moved = scroller.scrollTop > beforeTop + 8;
          const atBottom =
            scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;

          if (grew || moved) {
            stagnant = 0; // still making progress (new cards, taller feed, or scrolled)
          } else if (atBottom) {
            stagnant++; // parked at the bottom with nothing new — wait for a fetch
            await sleep(450);
          }
        }
      } finally {
        loading = false;
        setLoadingUI(false);
      }
    }

    // Target sizes: fill the grid on entry, then top up as you browse.
    const FILL = { pinterest: 30, focus: 8 };
    const prefetch = () => pumpUntil(cards.length + 16);

    // ---------------------------------------------------------------------
    function enter() {
      if (active) {
        // Already on — just switch which layout renders.
        root.classList.add("zf-overlay-active");
        if (cfg.layout === "pinterest") renderPinterestAll();
        else renderFocus();
        refreshBar();
        pumpUntil(FILL[cfg.layout] || 12); // top up so the new view isn't sparse
        return;
      }
      active = true;
      root.classList.add("zf-overlay-active");
      if (!document.body) {
        // document_start: wait for body.
        new MutationObserver((_, obs) => {
          if (document.body) { obs.disconnect(); enter2(); }
        }).observe(root, { childList: true, subtree: true });
        active = false; // enter2 will flip it
        return;
      }
      enter2();
    }

    function enter2() {
      active = true;
      if (!el) build();
      el.style.display = "block";
      seen.clear();
      cards.length = 0;
      focusIndex = 0;
      stage.innerHTML = "";
      showEmpty();
      refreshBar();

      observer = new MutationObserver(() => {
        // Debounced-ish: cheap scan on any mutation.
        scanAll();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      io = new IntersectionObserver(
        (entries) => entries.forEach((en) => en.isIntersecting && prefetch()),
        { root: el, rootMargin: "800px" }
      );
      io.observe(sentinel);

      document.addEventListener("keydown", onKey, true);
      scanAll();
      // Front-load a batch so the grid actually fills instead of sitting empty.
      pumpUntil(FILL[cfg.layout] || 12);
    }

    function exit() {
      root.classList.remove("zf-overlay-active");
      if (observer) { observer.disconnect(); observer = null; }
      if (io) { io.disconnect(); io = null; }
      document.removeEventListener("keydown", onKey, true);
      if (el) el.style.display = "none";
      active = false;
    }

    return { enter, exit, refreshBar };
  })();

  // Small helper so overlay buttons can write settings (fires storage.onChanged).
  function setCfg(patch) {
    Object.assign(cfg, patch);
    chrome.storage.sync.set(patch);
    apply();
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  load().then(apply);
})();
