# Quietfeed — a social-free X

A Chrome extension that strips the social pressure out of X/Twitter so you can
just look at good work and admire it. No like counts, no view counts, no
usernames, no timestamps — no FOMO, no impostor syndrome. Just the craft.

> **Why an extension (and not a userscript / bookmarklet)?**
> X is a single-page app that constantly re-renders and *virtualizes* its feed
> (it recycles a handful of DOM nodes as you scroll). A content-script extension
> is the cleanest way to (a) re-apply changes as the page mutates, (b) persist
> your settings across sessions, and (c) give you a proper popup "admin panel."

---

## What it does

Everything is toggleable from the popup (click the toolbar icon):

| Toggle | Effect |
| --- | --- |
| **Quietfeed is on** | Master switch. Off = X looks completely normal. |
| **Engagement counts** | Hides all the numbers (likes, reposts, replies, views) and the reply button. **Keeps the like, repost & bookmark buttons** so you can still like, save, and share good work — just without the counts. |
| **Identity** | Hides avatars, display names, @handles, and timestamps. |
| **Post text** | Optional — hide the words too, so you only see the visual work. |
| **Side panels** | Hides the left nav and the right sidebar (trends, who-to-follow). |

The **messages FAB / drawer is always kept** and floats above everything, so you
never lose your DMs. **Like**, **save (bookmark)**, and **repost** perform the
real action on your account — they click X's native button when the post is still
loaded, and otherwise call X's own API with your session, so they work even for
posts that have scrolled away. (They never navigate you off the page.)
- **Minimal** keeps the native like / repost / bookmark buttons on each post.
- **Pinterest** shows circular Like / Repost / Save buttons in the bottom-right
  of a card when you hover it.
- **Focus** has Save / Like / Repost in the bottom bar (or press **`s`** /
  **`l`** / **`r`**).

## Expanding a post (Pinterest)

Click any Pinterest card to open a **modal lightbox**: the media larger, the
caption for context, and Save / Repost. Videos play here (with sound and
controls); use the carousel arrows to page through multi-media posts. Click the
backdrop, the ✕, or press **Esc** to close.

Posts with multiple images/videos become a **carousel** (one at a time with a
`1/n` counter and arrows) instead of a tall stack.

In Pinterest/Focus, **only posts with media (images or video) become cards** —
these are the visual modes. The **Text** toggle then shows or hides the caption
*on those cards* (it doesn't flood the wall with text-only posts). The loader
keeps pulling the feed until it has enough media posts to fill the wall.

**Videos** play **muted and looping**, and only while they're on screen (so a
wall of clips stays light); **hover for playback controls**. GIFs play inline,
and regular clips play when their native player is still loaded. Streaming
videos whose player has scrolled out of the feed show their thumbnail with a ▶
(they don't navigate anywhere on click).

## Where it runs

Quietfeed only activates on the **main timeline** (`x.com/home` — For you /
Following). Click into a post, profile, or any other page and X looks completely
normal; it re-activates when you return to the timeline.

## The dock

A small floating **dock** sits in the top-right corner in every mode. It has a
segmented **Minimal / Pinterest / Focus** switch and a **Text: on/off** toggle,
so you can change views and show/hide post text without opening the popup. In the
Pinterest/Focus views it also gets a **Load more** button.

## Three explorations of the view

Pick one from the popup or the dock:

1. **Minimal** — the feed you know, scrubbed clean. Information is stripped in
   place; layout and scrolling are untouched. Most reliable, closest to "normal
   X but quiet."
2. **Pinterest** — a masonry wall of cards. Each post becomes a clean image card
   (multi-image posts become mini galleries), optionally with its text. Great
   for browsing a lot of visual work at once.
3. **Focus** — one piece of inspiration at a time, centered and large. Use the
   on-screen arrows or the **← / →** (and **↑ / ↓**) keys to move through it.
   Deliberately slow. Admire one thing, then the next.

Minimal is pure CSS applied to the live page. Pinterest and Focus are rendered
into a clean overlay: Quietfeed reads the images/text out of each tweet as it
scrolls into view and repaints them itself, while the (hidden) native feed keeps
loading more in the background.

## Install (unpacked, ~30 seconds)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `quietfeed/` folder.
4. Open [x.com](https://x.com) and click the Quietfeed icon to configure.

Your settings sync via `chrome.storage.sync`, so they follow your Chrome
profile.

## Notes & limitations

- Built against X's current DOM (`data-testid` hooks). If X ships a big redesign,
  a selector or two in `quietfeed.css` / `content.js` may need updating.
- **Pinterest / Focus are the experimental explorations.** Because X virtualizes
  and lazy-loads, the overlay can't rely on your scroll wheel (that scrolls the
  overlay, not X). Instead it *drives* X's own scroll container to the bottom in
  the background to force the next page to load, harvesting media as tweets
  render. It front-loads a batch on entry to fill the grid, tops up as you near
  the end, and there's a **Load more** button in the overlay toolbar if you ever
  want to pull more by hand. It favors posts that contain images. Minimal is the
  sturdiest everyday mode.
- Nothing leaves your browser. No network calls, no analytics, no accounts — the
  only permission requested is `storage` (to remember your toggles).

## File map

```
manifest.json    MV3 manifest
content.js       applies the "minimal" classes + renders the pinterest/focus overlay
quietfeed.css    all the hiding rules + overlay styling
popup.html/css/js the admin panel
icons/           extension icons
```
