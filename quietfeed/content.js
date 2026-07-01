/* =========================================================================
   Quietfeed content script
   - Applies body classes for the CSS-driven "minimal" view.
   - Harvests media/text from the virtualized native feed and repaints it
     into a clean overlay for "pinterest" and "focus" views.
   - Floating dock (top-right) switches modes + toggles post text in ALL views.
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

  // Small helper so dock/card buttons can write settings (fires storage.onChanged).
  function setCfg(patch) {
    Object.assign(cfg, patch);
    chrome.storage.sync.set(patch);
    apply();
  }

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
    if (wantOverlay) Overlay.enter();
    else Overlay.exit();

    Dock.update();
  }

  // ---------------------------------------------------------------------
  // Harvesting the native feed
  // ---------------------------------------------------------------------
  function upscale(url) {
    if (!url) return url;
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

    const el = article.querySelector('[data-testid="tweetText"]');
    const text = el ? el.innerText.trim() : "";

    // We always capture text (even when hidden) so the toggle can reveal it
    // later without needing to re-harvest. Skip only truly empty posts.
    if (imgs.length === 0 && !text) return null;

    return { id, imgs, text };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Find the element X actually scrolls.
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

  // Locate a still-rendered native <article> for a given tweet id.
  function findArticle(id) {
    const link = document.querySelector(`a[href*="/status/${id}"]`);
    return link ? link.closest("article") : null;
  }

  // Save / repost a post by id. Works from any view.
  function act(id, kind) {
    if (kind === "repost") {
      // Intent popup is reliable regardless of feed virtualization.
      window.open(
        `https://twitter.com/intent/retweet?tweet_id=${id}`,
        "zf_repost",
        "width=600,height=560,noopener"
      );
      return "opened";
    }
    if (kind === "bookmark") {
      const art = findArticle(id);
      const btn = art && art.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]');
      if (btn) {
        btn.click();
        return "saved";
      }
      // Not in the DOM anymore — open the post so it can be bookmarked there.
      window.open(`https://x.com/i/web/status/${id}`, "_blank", "noopener");
      return "opened";
    }
  }

  // ---------------------------------------------------------------------
  // Overlay controller (pinterest / focus)
  // ---------------------------------------------------------------------
  const Overlay = (() => {
    let el = null; // #zf-overlay
    let stage = null; // #zf-stage
    let sentinel = null;
    let observer = null;
    let io = null;
    let active = false;

    const byId = new Map(); // id -> card model
    const cards = []; // ordered card models
    let focusIndex = 0;
    let loading = false;

    function build() {
      el = document.createElement("div");
      el.id = "zf-overlay";

      stage = document.createElement("div");
      stage.id = "zf-stage";

      sentinel = document.createElement("div");
      sentinel.id = "zf-sentinel";

      el.append(stage, sentinel);
      document.body.appendChild(el);
    }

    // ---- harvest ----
    function ingest(article) {
      const data = extractCard(article);
      if (!data) return;

      const existing = byId.get(data.id);
      if (existing) {
        // Enrich: a post may render its image first and text a moment later.
        let changed = false;
        if (!existing.text && data.text) { existing.text = data.text; changed = true; }
        if (data.imgs.length > existing.imgs.length) { existing.imgs = data.imgs; changed = true; }
        if (changed) reRenderCard(existing);
        return;
      }

      byId.set(data.id, data);
      cards.push(data);
      if (cfg.layout === "pinterest") stage.appendChild(buildPinterestCard(data));
      else renderFocus();
      hideEmpty();
    }

    function scanAll() {
      document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => ingest(a));
    }

    // ---- shared card pieces ----
    function galleryEl(card) {
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

    function flash(btn, label) {
      const prev = btn.dataset.label;
      btn.textContent = label;
      btn.classList.add("zf-done");
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove("zf-done");
      }, 1400);
    }

    function actionsEl(card) {
      const row = document.createElement("div");
      row.className = "zf-actions";

      const save = document.createElement("button");
      save.type = "button";
      save.dataset.label = "Save";
      save.textContent = "Save";
      save.title = "Bookmark this post";
      save.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = act(card.id, "bookmark");
        flash(save, r === "saved" ? "Saved ✓" : "Opened ↗");
      });

      const rt = document.createElement("button");
      rt.type = "button";
      rt.dataset.label = "Repost";
      rt.textContent = "Repost";
      rt.title = "Repost this post";
      rt.addEventListener("click", (e) => {
        e.stopPropagation();
        act(card.id, "repost");
        flash(rt, "Repost ↗");
      });

      row.append(save, rt);
      return row;
    }

    // ---- pinterest ----
    function buildPinterestCard(card) {
      const c = document.createElement("div");
      c.className = "zf-card" + (card.imgs.length === 0 ? " zf-textonly" : "");
      if (card.imgs.length) c.appendChild(galleryEl(card));
      const t = textEl(card);
      if (t) c.appendChild(t);
      c.appendChild(actionsEl(card));
      card._node = c;
      return c;
    }

    function renderPinterestAll() {
      stage.innerHTML = "";
      cards.forEach((card) => stage.appendChild(buildPinterestCard(card)));
      hideEmpty();
    }

    // ---- focus ----
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
      card._node = null;

      const wrap = document.createElement("div");
      wrap.className = "zf-focus-card";
      if (card.imgs.length) wrap.appendChild(galleryEl(card));
      const t = textEl(card);
      if (t) wrap.appendChild(t);
      wrap.appendChild(actionsEl(card));
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

    // Re-render a single card in place after it was enriched.
    function reRenderCard(card) {
      if (cfg.layout === "focus") {
        if (cards[focusIndex] && cards[focusIndex].id === card.id) renderFocus();
        return;
      }
      if (card._node && card._node.isConnected) {
        card._node.replaceWith(buildPinterestCard(card));
      }
    }

    function go(delta) {
      focusIndex += delta;
      if (focusIndex >= cards.length - 3) pumpUntil(focusIndex + 10);
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
      if (!el || el.querySelector("#zf-empty")) return;
      const e = document.createElement("div");
      e.id = "zf-empty";
      e.textContent = "Looking for work to admire…";
      stage.appendChild(e);
    }
    function hideEmpty() {
      const e = el && el.querySelector("#zf-empty");
      if (e && cards.length) e.remove();
    }

    // ---- drive the (hidden) native feed to load more ----
    let pumpTarget = 0;
    async function pumpUntil(target, maxStagnant = 8) {
      pumpTarget = Math.max(pumpTarget, target);
      if (loading || !active) return;
      loading = true;
      Dock.setLoading(true);
      try {
        const scroller = getScroller();
        let stagnant = 0;
        while (active && cards.length < pumpTarget && stagnant < maxStagnant) {
          const beforeCards = cards.length;
          const beforeH = scroller.scrollHeight;
          const beforeTop = scroller.scrollTop;

          // Big steps (not a teleport) so X's virtualizer renders the tweets we
          // pass; reaching the bottom is what trips X's next-page fetch.
          const step = Math.max(700, scroller.clientHeight * 2.5);
          scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
          window.dispatchEvent(new Event("scroll"));

          await sleep(450);
          scanAll();

          const grew = cards.length > beforeCards || scroller.scrollHeight > beforeH + 20;
          const moved = scroller.scrollTop > beforeTop + 8;
          const atBottom =
            scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;

          if (grew || moved) stagnant = 0;
          else if (atBottom) { stagnant++; await sleep(450); }
        }
      } finally {
        loading = false;
        Dock.setLoading(false);
      }
    }

    const FILL = { pinterest: 30, focus: 8 };
    const prefetch = () => pumpUntil(cards.length + 16);
    const pumpMore = () => pumpUntil(cards.length + 20);

    // ---------------------------------------------------------------------
    function enter() {
      if (active) {
        root.classList.add("zf-overlay-active");
        if (cfg.layout === "pinterest") renderPinterestAll();
        else renderFocus();
        pumpUntil(FILL[cfg.layout] || 12);
        return;
      }
      if (!document.body) {
        new MutationObserver((_, obs) => {
          if (document.body) { obs.disconnect(); enter2(); }
        }).observe(root, { childList: true, subtree: true });
        return;
      }
      enter2();
    }

    function enter2() {
      active = true;
      root.classList.add("zf-overlay-active");
      if (!el) build();
      el.style.display = "block";
      byId.clear();
      cards.length = 0;
      focusIndex = 0;
      stage.innerHTML = "";
      showEmpty();

      observer = new MutationObserver(() => scanAll());
      observer.observe(document.body, { childList: true, subtree: true });

      io = new IntersectionObserver(
        (entries) => entries.forEach((en) => en.isIntersecting && prefetch()),
        { root: el, rootMargin: "800px" }
      );
      io.observe(sentinel);

      document.addEventListener("keydown", onKey, true);
      scanAll();
      pumpUntil(FILL[cfg.layout] || 12); // front-load so the grid fills
    }

    function exit() {
      root.classList.remove("zf-overlay-active");
      if (observer) { observer.disconnect(); observer = null; }
      if (io) { io.disconnect(); io = null; }
      document.removeEventListener("keydown", onKey, true);
      if (el) el.style.display = "none";
      active = false;
    }

    return { enter, exit, pumpMore };
  })();

  // ---------------------------------------------------------------------
  // Floating dock — mode switch + text toggle, visible in EVERY mode
  // ---------------------------------------------------------------------
  const Dock = (() => {
    let dock = null;
    let segMin, segPin, segFoc, textBtn, moreBtn;

    function seg(label, layout) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = "zf-seg-btn";
      b.addEventListener("click", () => setCfg({ layout }));
      return b;
    }

    function pill(label, cls, fn) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = "zf-pill " + (cls || "");
      b.addEventListener("click", fn);
      return b;
    }

    function build() {
      dock = document.createElement("div");
      dock.id = "zf-dock";

      const segWrap = document.createElement("div");
      segWrap.className = "zf-seg";
      segMin = seg("Minimal", "minimal");
      segPin = seg("Pinterest", "pinterest");
      segFoc = seg("Focus", "focus");
      segWrap.append(segMin, segPin, segFoc);

      textBtn = pill("Text", "", () => setCfg({ hideText: !cfg.hideText }));
      moreBtn = pill("Load more", "zf-more", () => Overlay.pumpMore());
      const off = pill("Off", "zf-off", () => setCfg({ enabled: false }));

      dock.append(segWrap, textBtn, moreBtn, off);
      document.body.appendChild(dock);
    }

    function ensure() {
      if (!dock && document.body) build();
    }

    function update() {
      ensure();
      if (!dock) return;
      dock.style.display = cfg.enabled ? "flex" : "none";
      segMin.classList.toggle("zf-on", cfg.layout === "minimal");
      segPin.classList.toggle("zf-on", cfg.layout === "pinterest");
      segFoc.classList.toggle("zf-on", cfg.layout === "focus");
      textBtn.textContent = cfg.hideText ? "Text: off" : "Text: on";
      textBtn.classList.toggle("zf-on", !cfg.hideText);
      moreBtn.style.display =
        cfg.layout === "pinterest" || cfg.layout === "focus" ? "" : "none";
    }

    function setLoading(on) {
      if (!moreBtn) return;
      moreBtn.textContent = on ? "Loading…" : "Load more";
      moreBtn.disabled = on;
    }

    return { update, setLoading };
  })();

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  load().then(apply);
  document.addEventListener("DOMContentLoaded", apply); // ensure dock builds
})();
