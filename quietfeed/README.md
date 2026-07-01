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
| **Engagement counts** | Hides the reply / repost / like / view / bookmark bar. |
| **Identity** | Hides avatars, display names, @handles, and timestamps. |
| **Post text** | Optional — hide the words too, so you only see the visual work. |
| **Side panels** | Hides the left nav and the right sidebar (trends, who-to-follow). |

The **messages FAB / drawer is always kept** and floats above everything, so you
never lose your DMs.

## Three explorations of the view

Pick one from the popup (or the slim toolbar inside the overlay views):

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
  and lazy-loads, the overlay harvests media progressively as it pulls more of
  the feed in the background; the first few cards may take a beat to appear, and
  it favors posts that contain images. Minimal is the sturdiest everyday mode.
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
