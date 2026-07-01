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
  // media: [{type:'image', src} | {type:'video', src|null, poster|null}]
  function extractCard(article) {
    const id = statusId(article);
    if (!id) return null;

    const media = [];
    article.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((img) => {
      const src = upscale(img.currentSrc || img.src);
      if (src && src.includes("pbs.twimg.com/media")) media.push({ type: "image", src });
    });
    article.querySelectorAll("video").forEach((v) => {
      const raw =
        v.currentSrc || v.src || (v.querySelector("source") && v.querySelector("source").src) || "";
      // Direct .mp4 (GIFs, short clips) is reusable; blob:/HLS is not, so we
      // fall back to the poster thumbnail for those.
      const direct = /^https?:\/\/[^ ]+\.mp4/i.test(raw) ? raw : null;
      const poster = v.poster && /^https?:/.test(v.poster) ? v.poster : null;
      if (direct || poster) media.push({ type: "video", src: direct, poster });
    });

    const el = article.querySelector('[data-testid="tweetText"]');
    // IMPORTANT: use textContent, not innerText. While the overlay is up the
    // native feed is visibility:hidden, and innerText returns "" for hidden
    // elements — which is why captions never showed. textContent ignores
    // visibility and gives us the words regardless.
    const text = el ? el.textContent.trim() : "";

    if (media.length === 0 && !text) return null;

    return { id, media, text };
  }

  // X's own bookmark / repost icons so the actions feel native.
  const ICONS = {
    bookmark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z"></path></svg>',
    bookmarkFilled:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z"></path></svg>',
    repost:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"></path></svg>',
  };

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
    let focusList = []; // currently-visible cards, in order (Focus navigation)
    let focusIndex = 0;
    let focusCountEl = null;
    let loading = false;
    let videoIO = null; // plays only on-screen videos, pauses the rest

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

    // These are visual modes: only posts with media (image/video) become cards.
    // The Text toggle then shows/hides the caption on those cards.
    function isVisible(card) {
      return card.media.length > 0;
    }
    const visibleCards = () => cards.filter(isVisible);

    // ---- harvest ----
    function ingest(article) {
      const data = extractCard(article);
      if (!data) return;

      const existing = byId.get(data.id);
      if (existing) {
        // Enrich: a post may render media/text a moment after it first appears.
        let changed = false;
        if (!existing.text && data.text) { existing.text = data.text; changed = true; }
        if (data.media.length > existing.media.length) { existing.media = data.media; changed = true; }
        if (changed) reRenderCard(existing);
        return;
      }

      byId.set(data.id, data);
      cards.push(data);
      if (!isVisible(data)) return; // keep it (Text toggle may reveal it) but don't render an empty card
      if (cfg.layout === "pinterest") placePinterest(data);
      else if (focusList.length === 0) renderFocus(); // first visible card
      else syncFocusCount(); // otherwise just keep the "n / total" live, no reload
      hideEmpty();
    }

    function syncFocusCount() {
      focusList = visibleCards();
      if (focusCountEl) focusCountEl.textContent = `${focusIndex + 1} / ${focusList.length}`;
    }

    function scanAll() {
      document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => ingest(a));
    }

    // Build a single media slide (image, playable video, or video poster).
    function mediaNode(item, card) {
      if (item.type === "video" && item.src) {
        const v = document.createElement("video");
        v.className = "zf-slide";
        v.src = item.src;
        if (item.poster) v.poster = item.poster;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.preload = "metadata";
        v.setAttribute("controlslist", "nodownload noplaybackrate noremoteplayback");
        // Controls appear on hover; only on-screen videos actually play (videoIO).
        v.addEventListener("mouseenter", () => { v.controls = true; });
        v.addEventListener("mouseleave", () => { v.controls = false; });
        if (videoIO) videoIO.observe(v);
        return v;
      }
      if (item.type === "video") {
        // No reusable stream (blob/HLS): show the poster with a play badge that
        // opens the post to watch it.
        const wrap = document.createElement("div");
        wrap.className = "zf-slide zf-videoposter";
        if (item.poster) {
          const img = document.createElement("img");
          img.loading = "lazy";
          img.referrerPolicy = "no-referrer";
          img.src = item.poster;
          wrap.appendChild(img);
        }
        const play = document.createElement("span");
        play.className = "zf-play";
        play.textContent = "▶";
        wrap.appendChild(play);
        wrap.addEventListener("click", (e) => {
          e.stopPropagation();
          window.open(`https://x.com/i/web/status/${card.id}`, "_blank", "noopener");
        });
        return wrap;
      }
      const img = document.createElement("img");
      img.className = "zf-slide";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = item.src;
      // If a lone image fails and there's nothing else to show, drop the card.
      img.addEventListener("error", () => {
        if (card.media.length <= 1 && !card.text && card._node && card._node.isConnected) {
          card._node.remove();
        }
      });
      return img;
    }

    // ---- media carousel: one slide at a time; handles multi-media posts ----
    function mediaEl(card) {
      const wrap = document.createElement("div");
      wrap.className = "zf-media";
      const items = card.media;
      if (!items.length) return wrap;

      let idx = 0;
      const nodes = items.map((it) => mediaNode(it, card));
      nodes.forEach((n, i) => {
        if (i !== 0) n.style.display = "none";
        wrap.appendChild(n);
      });

      const multi = items.length > 1;
      let badge = null;
      const show = () => {
        idx = (idx + items.length) % items.length;
        nodes.forEach((n, i) => { n.style.display = i === idx ? "" : "none"; });
        if (badge) badge.textContent = `${idx + 1}/${items.length}`;
      };

      if (multi) {
        wrap.classList.add("zf-multi");
        badge = document.createElement("span");
        badge.className = "zf-count-badge";
        const arrow = (cls, txt, d) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = cls;
          b.textContent = txt;
          b.addEventListener("click", (e) => { e.stopPropagation(); idx += d; show(); });
          return b;
        };
        wrap.append(badge, arrow("zf-car zf-car-prev", "‹", -1), arrow("zf-car zf-car-next", "›", 1));
      }
      show();
      return wrap;
    }

    function textEl(card) {
      if (cfg.hideText || !card.text) return null;
      const t = document.createElement("div");
      t.className = "zf-text";
      t.textContent = card.text;
      return t;
    }

    // ---- actions ----
    function markDone(btn, kind, result) {
      if (kind === "bookmark" && result === "saved") {
        btn.querySelector("svg").outerHTML = ICONS.bookmarkFilled;
      }
      btn.classList.add("zf-done");
      setTimeout(() => btn.classList.remove("zf-done"), 1200);
    }

    function iconBtn(kind, card, withLabel) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = withLabel ? "zf-big-btn" : "zf-icon-btn";
      b.title = kind === "bookmark" ? "Save" : "Repost";
      b.innerHTML = ICONS[kind] + (withLabel ? `<span>${kind === "bookmark" ? "Save" : "Repost"}</span>` : "");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = act(card.id, kind);
        markDone(b, kind, r);
      });
      return b;
    }

    // Circular hover actions for Pinterest cards (bottom-right).
    function hoverActions(card) {
      const row = document.createElement("div");
      row.className = "zf-hover-actions";
      row.append(iconBtn("repost", card, false), iconBtn("bookmark", card, false));
      return row;
    }

    // Bigger labeled actions for Focus.
    function focusActions(card) {
      const row = document.createElement("div");
      row.className = "zf-focus-actions";
      row.append(iconBtn("bookmark", card, true), iconBtn("repost", card, true));
      return row;
    }

    // ---- pinterest (JS masonry: stable, fills the shortest column) ----
    let columns = [];
    let colHeights = [];

    function columnCount() {
      const w = (stage && stage.clientWidth) || 1180;
      return Math.max(1, Math.min(6, Math.floor(w / 250)));
    }

    function buildColumns() {
      stage.innerHTML = "";
      columns = [];
      const n = columnCount();
      colHeights = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        const c = document.createElement("div");
        c.className = "zf-col";
        stage.appendChild(c);
        columns.push(c);
      }
    }

    function buildPinterestCard(card) {
      const c = document.createElement("div");
      c.className = "zf-card";
      c.appendChild(mediaEl(card));
      const t = textEl(card);
      if (t) c.appendChild(t);
      c.appendChild(hoverActions(card));
      card._node = c;
      return c;
    }

    function placePinterest(card) {
      if (!columns.length) buildColumns();
      const node = buildPinterestCard(card);
      // Choose the shortest column using a running height estimate so cards
      // land row-by-row instead of reflowing left-to-right.
      let i = 0;
      for (let k = 1; k < colHeights.length; k++) if (colHeights[k] < colHeights[i]) i = k;
      columns[i].appendChild(node);
      const est = 320;
      colHeights[i] += est;
      const media = node.querySelector("img, video");
      const correct = () => { colHeights[i] += (node.offsetHeight || est) - est; };
      if (media && media.tagName === "IMG" && !media.complete) media.addEventListener("load", correct, { once: true });
      else if (media && media.tagName === "VIDEO") media.addEventListener("loadedmetadata", correct, { once: true });
      else correct();
    }

    function renderPinterestAll() {
      buildColumns();
      visibleCards().forEach((card) => placePinterest(card));
      hideEmpty();
    }

    // ---- focus ----
    function renderFocus() {
      if (cfg.layout !== "focus") return;
      stage.innerHTML = "";
      focusList = visibleCards();
      if (!focusList.length) {
        showEmpty();
        return;
      }
      hideEmpty();
      focusIndex = Math.max(0, Math.min(focusIndex, focusList.length - 1));
      const card = focusList[focusIndex];
      card._node = null;

      const wrap = document.createElement("div");
      wrap.className = "zf-focus-card";
      if (card.media.length) wrap.appendChild(mediaEl(card));
      const t = textEl(card);
      if (t) wrap.appendChild(t);
      wrap.appendChild(focusActions(card));
      stage.appendChild(wrap);

      const nav = document.createElement("div");
      nav.className = "zf-focus-nav";
      const prev = document.createElement("button");
      prev.textContent = "‹";
      prev.disabled = focusIndex === 0;
      prev.addEventListener("click", () => go(-1));
      const count = document.createElement("span");
      count.className = "zf-count";
      count.textContent = `${focusIndex + 1} / ${focusList.length}`;
      focusCountEl = count;
      const next = document.createElement("button");
      next.textContent = "›";
      next.addEventListener("click", () => go(1));
      nav.append(prev, count, next);
      stage.appendChild(nav);
    }

    // Re-render a single card in place after it was enriched.
    function reRenderCard(card) {
      if (cfg.layout === "focus") {
        if (focusList[focusIndex] && focusList[focusIndex].id === card.id) renderFocus();
        return;
      }
      if (card._node && card._node.isConnected) {
        card._node.replaceWith(buildPinterestCard(card));
      }
    }

    function go(delta) {
      focusIndex += delta;
      if (focusIndex >= visibleCards().length - 3) pumpUntil(focusIndex + 10);
      renderFocus();
      el.scrollTo({ top: 0 });
    }

    function typingInField() {
      const a = document.activeElement;
      return a && (/^(input|textarea)$/i.test(a.tagName) || a.isContentEditable);
    }

    function onKey(e) {
      if (!active || cfg.layout !== "focus" || typingInField()) return;
      const card = focusList[focusIndex];
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(-1); }
      else if (e.key === "s" || e.key === "S") { if (card) act(card.id, "bookmark"); }
      else if (e.key === "r" || e.key === "R") { if (card) act(card.id, "repost"); }
    }

    let resizeT = 0;
    function onResize() {
      if (cfg.layout !== "pinterest") return;
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (columnCount() !== columns.length) renderPinterestAll();
      }, 200);
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
      if (e && visibleCards().length) e.remove();
    }

    // ---- drive the (hidden) native feed to load more ----
    // `target` is a count of VISIBLE cards (image posts, or text posts when
    // Text is on) — text-only posts don't count, so the wall actually fills.
    const HARVEST_CAP = 600; // safety stop so we never scroll forever
    let pumpTarget = 0;
    async function pumpUntil(target, maxStagnant = 10) {
      pumpTarget = Math.max(pumpTarget, target);
      if (loading || !active) return;
      loading = true;
      Dock.setLoading(true);
      try {
        const scroller = getScroller();
        let stagnant = 0;
        while (
          active &&
          visibleCards().length < pumpTarget &&
          cards.length < HARVEST_CAP &&
          stagnant < maxStagnant
        ) {
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

    const FILL = { pinterest: 24, focus: 6 }; // visible-card targets
    const prefetch = () => pumpUntil(visibleCards().length + 14);
    const pumpMore = () => pumpUntil(visibleCards().length + 18);

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
      focusList = [];
      focusIndex = 0;
      stage.innerHTML = "";
      showEmpty();

      // Play only videos that are actually on screen (and, since hidden slides
      // are display:none, only the visible slide of each carousel).
      videoIO = new IntersectionObserver(
        (entries) => entries.forEach((en) => {
          const v = en.target;
          if (en.isIntersecting) { const p = v.play(); if (p) p.catch(() => {}); }
          else v.pause();
        }),
        { root: el, threshold: 0.4 }
      );

      observer = new MutationObserver(() => scanAll());
      observer.observe(document.body, { childList: true, subtree: true });

      io = new IntersectionObserver(
        (entries) => entries.forEach((en) => en.isIntersecting && prefetch()),
        { root: el, rootMargin: "800px" }
      );
      io.observe(sentinel);

      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onResize);
      scanAll();
      pumpUntil(FILL[cfg.layout] || 12); // front-load so the grid fills
    }

    function exit() {
      root.classList.remove("zf-overlay-active");
      if (observer) { observer.disconnect(); observer = null; }
      if (io) { io.disconnect(); io = null; }
      if (videoIO) { videoIO.disconnect(); videoIO = null; }
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
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
