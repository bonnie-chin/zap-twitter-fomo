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

  // The post the user is currently looking at, so switching modes lands on it.
  // { id, nativeTop }
  let anchor = null;

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

  // Only run on the main timeline (Home / "For you" / "Following") — not on an
  // individual post, profile, or other page. Re-checked on SPA navigation.
  function isActivePage() {
    const p = location.pathname;
    return p === "/" || p === "/home";
  }

  // ---------------------------------------------------------------------
  // Apply state
  // ---------------------------------------------------------------------
  function apply() {
    const on = cfg.enabled && isActivePage();

    root.classList.toggle("zf-enabled", on);
    root.classList.toggle("zf-hide-metrics", on && cfg.hideMetrics);
    root.classList.toggle("zf-hide-identity", on && cfg.hideIdentity);
    root.classList.toggle("zf-hide-text", on && cfg.hideText);
    root.classList.toggle("zf-hide-chrome", on && cfg.hideChrome);

    root.classList.toggle("zf-mode-minimal", on && cfg.layout === "minimal");
    root.classList.toggle("zf-mode-pinterest", on && cfg.layout === "pinterest");
    root.classList.toggle("zf-mode-focus", on && cfg.layout === "focus");

    const wantOverlay = on && (cfg.layout === "pinterest" || cfg.layout === "focus");
    if (wantOverlay) Overlay.enter();
    else {
      Overlay.exit();
      if (on && cfg.layout === "minimal") requestAnimationFrame(alignMinimal);
    }

    Dock.update(on);
  }

  // Scroll the native feed to the anchor post (used when entering Minimal).
  function alignMinimal() {
    if (!anchor || anchor.nativeTop == null) return;
    const scroller = getScroller();
    scroller.scrollTop = Math.max(0, anchor.nativeTop - 60);
  }

  // Track the top-most visible tweet as the anchor while in Minimal.
  let minimalScrollThrottled = false;
  function onMinimalScroll() {
    if (minimalScrollThrottled) return;
    if (!cfg.enabled || cfg.layout !== "minimal" || !isActivePage()) return;
    minimalScrollThrottled = true;
    requestAnimationFrame(() => { minimalScrollThrottled = false; });
    let best = null;
    let bestTop = Infinity;
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      const r = a.getBoundingClientRect();
      if (r.bottom > 120 && r.top < bestTop) { bestTop = r.top; best = a; }
    });
    if (best) {
      const id = statusId(best);
      if (id) anchor = { id, nativeTop: nativeOffset(best) };
    }
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
      let src = /^https?:\/\/[^ ]+\.mp4/i.test(raw) ? raw : null;
      const poster = v.poster && /^https?:/.test(v.poster) ? v.poster : null;
      // GIF-style clips ("tweet_video") have a derivable direct MP4 we can
      // autoplay; regular blob/HLS videos don't, so we adopt the live element
      // when possible or fall back to the poster.
      if (!src && poster) {
        const m = poster.match(/tweet_video_thumb\/([A-Za-z0-9_-]+)/);
        if (m) src = `https://video.twimg.com/tweet_video/${m[1]}.mp4`;
      }
      if (src || poster) media.push({ type: "video", src, poster });
    });

    const el = article.querySelector('[data-testid="tweetText"]');
    // IMPORTANT: use textContent, not innerText. While the overlay is up the
    // native feed is visibility:hidden, and innerText returns "" for hidden
    // elements — which is why captions never showed. textContent ignores
    // visibility and gives us the words regardless.
    const text = el ? el.textContent.trim() : "";

    if (media.length === 0 && !text) return null;

    // Reflect the post's current state so our buttons show it correctly.
    const saved = !!article.querySelector('[data-testid="removeBookmark"]');
    const liked = !!article.querySelector('[data-testid="unlike"]');
    const reposted = !!article.querySelector('[data-testid="unretweet"]');

    return { id, media, text, saved, liked, reposted, nativeTop: null };
  }

  // Absolute scroll offset of a tweet's cell within X's scroll container.
  function nativeOffset(el) {
    const scroller = getScroller();
    const cell = el.closest('[data-testid="cellInnerDiv"]') || el;
    const r = cell.getBoundingClientRect();
    const winScroll =
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body;
    const base = winScroll
      ? window.scrollY || document.documentElement.scrollTop || 0
      : scroller.scrollTop - scroller.getBoundingClientRect().top;
    return Math.round(r.top + base);
  }

  // X's own bookmark / repost / like icons so the actions feel native.
  const ICONS = {
    bookmark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z"></path></svg>',
    bookmarkFilled:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z"></path></svg>',
    repost:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"></path></svg>',
    like:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91z"></path></svg>',
    likeFilled:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"></path></svg>',
  };
  const ACTION_LABEL = { bookmark: "Save", repost: "Repost", like: "Like" };
  const STATE_FIELD = { bookmark: "saved", repost: "reposted", like: "liked" };

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

  // Wait for a menu item (e.g. the repost confirmation) to appear, then click.
  function clickMenuItem(testid, tries = 24) {
    return new Promise((resolve) => {
      let n = 0;
      const t = setInterval(() => {
        const c = document.querySelector(`[data-testid="${testid}"]`);
        if (c) { clearInterval(t); c.click(); resolve(true); }
        else if (++n > tries) { clearInterval(t); resolve(false); }
      }, 50);
    });
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
        // Pick up state that became true (e.g. saved/liked elsewhere).
        for (const f of ["saved", "liked", "reposted"]) {
          if (data[f] && !existing[f]) { existing[f] = true; changed = true; }
        }
        if (data.nativeTop != null && existing.nativeTop == null) existing.nativeTop = data.nativeTop;
        if (changed) reRenderCard(existing);
        return;
      }

      // Remember where this tweet sits in X's virtual list so we can scroll
      // back to it later (to act on it, adopt its video, or sync scroll).
      data.nativeTop = nativeOffset(article);
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

    // Configure a <video>. mode: "feed" (muted autoplay on screen, no controls
    // — click opens the modal), "focus"/"modal" (controls, playable, with sound
    // in the modal).
    function dressVideo(v, mode) {
      v.className = "zf-slide";
      v.loop = true;
      v.playsInline = true;
      v.setAttribute("controlslist", "nodownload noplaybackrate noremoteplayback");
      if (mode === "modal") {
        v.muted = false;
        v.controls = true;
        const p = v.play(); // opened via a click, so playback is allowed
        if (p) p.catch(() => {});
      } else {
        v.muted = true;
        v.controls = mode === "focus";
        if (videoIO) videoIO.observe(v); // only on-screen videos actually play
      }
      return v;
    }

    // Run `fn(article)` with the tweet's native <article> rendered — using it
    // if it's already in the DOM, otherwise scrolling X's hidden feed back to
    // the tweet's remembered position so X re-renders it. `fn` runs WHILE it's
    // rendered (before we restore the scroll), so it can click native buttons
    // or detach the live <video>. Invisible (behind the overlay). Serialized.
    let recalling = false;
    async function withRenderedTweet(card, fn) {
      if (recalling || !active) return null;
      recalling = true;
      try {
        // Let any in-flight loader pass finish so we don't fight over the scroll.
        let waited = 0;
        while (loading && waited < 2000) { await sleep(100); waited += 100; }

        let art = findArticle(card.id);
        if (art) return await fn(art);
        if (card.nativeTop == null) return null;

        const scroller = getScroller();
        const saved = scroller.scrollTop;
        try {
          for (let i = 0; i < 14 && active; i++) {
            const nudge = i === 0 ? 0 : (i % 2 ? 1 : -1) * scroller.clientHeight * 0.25 * Math.ceil(i / 2);
            scroller.scrollTop = Math.max(0, card.nativeTop - scroller.clientHeight * 0.35 + nudge);
            window.dispatchEvent(new Event("scroll"));
            await sleep(90);
            art = findArticle(card.id);
            if (art) return await fn(art); // finally (below) restores scroll after fn resolves
          }
          return null;
        } finally {
          scroller.scrollTop = saved;
          window.dispatchEvent(new Event("scroll"));
        }
      } finally {
        recalling = false;
      }
    }

    // Recall a streaming video's live <video> (detached so restoring the scroll
    // can't let X recycle it).
    function recall(card) {
      return withRenderedTweet(card, (art) => {
        const v = art.querySelector("video");
        if (!v) return null;
        v.dataset.zfAdopted = "1";
        v.remove();
        return v;
      });
    }

    // Perform a like/save/repost by clicking X's native button (bringing the
    // tweet into the DOM first if needed). Toggles, and returns the NEW state
    // (true/false) or null if it couldn't be done.
    function doAction(card, kind) {
      return withRenderedTweet(card, async (art) => {
        const q = (s) => art.querySelector(s);
        if (kind === "bookmark") {
          if (q('[data-testid="bookmark"]')) { q('[data-testid="bookmark"]').click(); return true; }
          if (q('[data-testid="removeBookmark"]')) { q('[data-testid="removeBookmark"]').click(); return false; }
        } else if (kind === "like") {
          if (q('[data-testid="like"]')) { q('[data-testid="like"]').click(); return true; }
          if (q('[data-testid="unlike"]')) { q('[data-testid="unlike"]').click(); return false; }
        } else if (kind === "repost") {
          if (q('[data-testid="retweet"]')) {
            q('[data-testid="retweet"]').click();
            await clickMenuItem("retweetConfirm");
            return true;
          }
          if (q('[data-testid="unretweet"]')) {
            q('[data-testid="unretweet"]').click();
            await clickMenuItem("unretweetConfirm");
            return false;
          }
        }
        return null;
      });
    }

    // After rendering a single-video card that fell back to a poster, try to
    // recall the real player and swap it in. mode: "focus" | "modal".
    async function enhanceVideos(scope, card, mode) {
      if (!card.media || card.media.length !== 1 || card.media[0].type !== "video") return;
      const poster = scope.querySelector(".zf-videoposter");
      if (!poster) return; // already playable (GIF / direct / adopted)
      poster.classList.add("zf-recalling"); // show a spinner while we fetch the player
      const v = await recall(card);
      if (!poster.isConnected) return;
      poster.classList.remove("zf-recalling");
      if (!v) return;
      v.dataset.zfAdopted = "1";
      dressVideo(v, mode);
      poster.replaceWith(v);
    }

    // Build a single media slide (image, playable video, or video poster).
    function mediaNode(item, card, mode) {
      if (item.type === "video") {
        // 1) In focus/modal, adopt the live native <video> if present — the only
        //    way to play blob/HLS clips (their stream can't be reused).
        if (mode !== "feed") {
          const art = findArticle(card.id);
          const native = art && art.querySelector("video");
          if (native && !native.dataset.zfAdopted) {
            try {
              native.dataset.zfAdopted = "1";
              return dressVideo(native, mode); // relocates it into our slide
            } catch (e) { /* fall through */ }
          }
        }
        // 2) A direct/GIF MP4 we can play in our own element.
        if (item.src) {
          const v = document.createElement("video");
          v.src = item.src;
          if (item.poster) v.poster = item.poster;
          v.preload = "metadata";
          return dressVideo(v, mode);
        }
        // 3) Fallback: a poster. In the feed, clicking the card opens the modal.
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
    function mediaEl(card, mode) {
      mode = mode || "feed";
      const wrap = document.createElement("div");
      wrap.className = "zf-media";
      const items = card.media;
      if (!items.length) return wrap;

      let idx = 0;
      const nodes = items.map((it) => mediaNode(it, card, mode));
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
    // A button that reflects the post's live state (card.saved/liked/reposted).
    function iconBtn(kind, card, withLabel) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = withLabel ? "zf-big-btn" : "zf-icon-btn";
      b.title = ACTION_LABEL[kind];
      const field = STATE_FIELD[kind];

      const paint = () => {
        const active = !!card[field];
        let icon = ICONS[kind];
        if (active && kind === "bookmark") icon = ICONS.bookmarkFilled;
        if (active && kind === "like") icon = ICONS.likeFilled;
        b.innerHTML = icon + (withLabel ? `<span>${ACTION_LABEL[kind]}</span>` : "");
        b.classList.toggle("zf-act-save", active && kind === "bookmark");
        b.classList.toggle("zf-act-like", active && kind === "like");
        b.classList.toggle("zf-act-repost", active && kind === "repost");
      };
      paint();

      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (b.disabled) return;
        b.disabled = true;
        const r = await doAction(card, kind); // toggles; returns new state or null
        if (r === null) { b.classList.add("zf-fail"); setTimeout(() => b.classList.remove("zf-fail"), 1400); }
        else { card[field] = r; paint(); }
        b.disabled = false;
      });
      return b;
    }

    // Circular hover actions for Pinterest cards (bottom-right).
    function hoverActions(card) {
      const row = document.createElement("div");
      row.className = "zf-hover-actions";
      row.append(iconBtn("like", card, false), iconBtn("repost", card, false), iconBtn("bookmark", card, false));
      return row;
    }

    // ---- modal lightbox (click a Pinterest card) ----
    let modalEl = null;
    let modalKeyHandler = null;

    function closeModal() {
      if (modalEl) { modalEl.remove(); modalEl = null; }
      if (modalKeyHandler) {
        document.removeEventListener("keydown", modalKeyHandler, true);
        modalKeyHandler = null;
      }
    }

    function openModal(card) {
      closeModal();
      modalEl = document.createElement("div");
      modalEl.id = "zf-modal";
      modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });

      const panel = document.createElement("div");
      panel.className = "zf-modal-panel";

      if (card.media.length) {
        panel.appendChild(mediaEl(card, "modal"));
        enhanceVideos(panel, card, "modal"); // recall a streaming video if needed
      }

      // Caption is always shown here for context, even if Text is off.
      if (card.text) {
        const t = document.createElement("div");
        t.className = "zf-text zf-modal-text";
        t.textContent = card.text;
        panel.appendChild(t);
      }

      const actions = document.createElement("div");
      actions.className = "zf-modal-actions";
      actions.append(iconBtn("bookmark", card, true), iconBtn("like", card, true), iconBtn("repost", card, true));
      panel.appendChild(actions);

      const close = document.createElement("button");
      close.className = "zf-modal-close";
      close.setAttribute("aria-label", "Close");
      close.textContent = "✕";
      close.addEventListener("click", closeModal);

      modalEl.append(panel, close);
      document.body.appendChild(modalEl);

      modalKeyHandler = (e) => { if (e.key === "Escape") { e.preventDefault(); closeModal(); } };
      document.addEventListener("keydown", modalKeyHandler, true);
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
      c.appendChild(mediaEl(card, "feed"));
      const t = textEl(card);
      if (t) c.appendChild(t);
      c.appendChild(hoverActions(card));
      // Click the card (but not its action buttons / carousel arrows) → modal.
      c.addEventListener("click", () => openModal(card));
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
      anchor = { id: card.id, nativeTop: card.nativeTop }; // remember for mode switches

      const wrap = document.createElement("div");
      wrap.className = "zf-focus-card";
      if (card.media.length) wrap.appendChild(mediaEl(card, "focus"));
      const t = textEl(card);
      if (t) wrap.appendChild(t);
      stage.appendChild(wrap);
      enhanceVideos(wrap, card, "focus"); // recall a streaming video if needed

      // Bottom-center bar: Save · ‹ · n/total · › · Repost
      const nav = document.createElement("div");
      nav.className = "zf-focus-nav";
      const save = iconBtn("bookmark", card, true);
      const like = iconBtn("like", card, true);
      const prev = document.createElement("button");
      prev.className = "zf-step";
      prev.textContent = "‹";
      prev.disabled = focusIndex === 0;
      prev.addEventListener("click", () => go(-1));
      const count = document.createElement("span");
      count.className = "zf-count";
      count.textContent = `${focusIndex + 1} / ${focusList.length}`;
      focusCountEl = count;
      const next = document.createElement("button");
      next.className = "zf-step";
      next.textContent = "›";
      next.addEventListener("click", () => go(1));
      const rt = iconBtn("repost", card, true);
      nav.append(save, like, prev, count, next, rt);
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

    function kbdAct(card, kind) {
      const field = STATE_FIELD[kind];
      if (!card) return;
      doAction(card, kind).then((r) => { if (r !== null) { card[field] = r; renderFocus(); } });
    }

    function onKey(e) {
      if (!active || cfg.layout !== "focus" || typingInField()) return;
      const card = focusList[focusIndex];
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(-1); }
      else if (e.key === "s" || e.key === "S") { kbdAct(card, "bookmark"); }
      else if (e.key === "r" || e.key === "R") { kbdAct(card, "repost"); }
      else if (e.key === "l" || e.key === "L") { kbdAct(card, "like"); }
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
    const HARVEST_CAP = 1500; // safety stop so we never scroll forever
    let pumpTarget = 0;
    const kick = (scroller) => {
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("scroll"));
    };
    async function pumpUntil(target, maxStagnant = 6) {
      pumpTarget = Math.max(pumpTarget, target);
      if (loading || recalling || !active) return;
      loading = true;
      Dock.setLoading(true);
      try {
        let stagnant = 0;
        while (
          active &&
          !recalling &&
          visibleCards().length < pumpTarget &&
          cards.length < HARVEST_CAP &&
          stagnant < maxStagnant
        ) {
          const scroller = getScroller(); // recompute — X can swap scroll containers
          const beforeCards = cards.length;
          const beforeH = scroller.scrollHeight;

          scroller.scrollTop = scroller.scrollHeight; // to the bottom → trips X's fetch
          kick(scroller);
          await sleep(400);
          scanAll();

          let grew = cards.length > beforeCards || scroller.scrollHeight > beforeH + 20;

          // If nothing loaded, "jiggle": back up a few screens then return to the
          // bottom so X's loader re-observes its sentinel and fetches again.
          if (!grew) {
            scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight * 3);
            kick(scroller);
            await sleep(350);
            scroller.scrollTop = scroller.scrollHeight;
            kick(scroller);
            await sleep(650);
            scanAll();
            grew = cards.length > beforeCards || scroller.scrollHeight > beforeH + 20;
          }

          stagnant = grew ? 0 : stagnant + 1;
        }
      } finally {
        loading = false;
        Dock.setLoading(false);
      }
    }

    const FILL = { pinterest: 30, focus: 6 }; // visible-card targets
    // Keep a generous buffer loaded ahead so the wall feels infinite.
    const prefetch = () => pumpUntil(visibleCards().length + 30);
    const pumpMore = () => pumpUntil(visibleCards().length + 30);

    // Trigger loading well before the bottom (both a big IO margin and a
    // scroll check, since IO margins on a scroll-container root can be flaky).
    let scrollThrottled = false;
    function onOverlayScroll() {
      if (!active || scrollThrottled) return;
      scrollThrottled = true;
      requestAnimationFrame(() => { scrollThrottled = false; });
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remaining < el.clientHeight * 3) prefetch();
      if (cfg.layout === "pinterest") trackPinterestAnchor();
    }

    // Anchor = the top-most card currently in view (for mode-switch sync).
    function trackPinterestAnchor() {
      const top = el.getBoundingClientRect().top + 90; // clear the dock
      let best = null;
      let bestTop = Infinity;
      for (const card of visibleCards()) {
        const n = card._node;
        if (!n || !n.isConnected) continue;
        const r = n.getBoundingClientRect();
        if (r.bottom > top && r.top < bestTop) { bestTop = r.top; best = card; }
      }
      if (best) anchor = { id: best.id, nativeTop: best.nativeTop };
    }

    function alignFocusToAnchor() {
      if (!anchor) return;
      const i = visibleCards().findIndex((c) => c.id === anchor.id);
      if (i >= 0) focusIndex = i;
    }

    function alignPinterestToAnchor() {
      if (!anchor) return;
      const card = byId.get(anchor.id);
      if (card && card._node && card._node.isConnected) {
        const top =
          card._node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 80;
        el.scrollTo({ top: Math.max(0, top) });
      }
    }

    // ---------------------------------------------------------------------
    function enter() {
      if (active) {
        root.classList.add("zf-overlay-active");
        closeModal();
        if (cfg.layout === "pinterest") {
          renderPinterestAll();
          requestAnimationFrame(alignPinterestToAnchor);
        } else {
          alignFocusToAnchor();
          renderFocus();
        }
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
        { root: el, rootMargin: "2500px" } // start loading long before the bottom
      );
      io.observe(sentinel);

      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onResize);
      el.addEventListener("scroll", onOverlayScroll, { passive: true });
      scanAll();
      // Land on the post we were just looking at, if we've harvested it.
      if (cfg.layout === "focus") { alignFocusToAnchor(); renderFocus(); }
      else requestAnimationFrame(alignPinterestToAnchor);
      pumpUntil(FILL[cfg.layout] || 12); // front-load so the grid fills
    }

    function exit() {
      root.classList.remove("zf-overlay-active");
      closeModal();
      if (observer) { observer.disconnect(); observer = null; }
      if (io) { io.disconnect(); io = null; }
      if (videoIO) { videoIO.disconnect(); videoIO = null; }
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      if (el) el.removeEventListener("scroll", onOverlayScroll);
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

    function update(on) {
      ensure();
      if (!dock) return;
      dock.style.display = on ? "flex" : "none";
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
  window.addEventListener("scroll", onMinimalScroll, { passive: true }); // anchor tracking in Minimal

  // X is a SPA — re-apply on route changes so we activate only on the main
  // timeline and back off the moment you click into a post.
  let lastPath = location.pathname;
  const onRoute = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      apply();
    }
  };
  ["pushState", "replaceState"].forEach((m) => {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      onRoute();
      return r;
    };
  });
  window.addEventListener("popstate", onRoute);
  // Safety net in case a navigation slips through the history hooks.
  setInterval(onRoute, 1000);
})();
