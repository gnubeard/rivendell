# Composer image-paste — manual QA checklist

The Playwright suite (`web/e2e/composer-paste.spec.js`) covers the three automated
harvest channels and the textarea-facade behaviors, but a few real-device flows
can't be exercised headlessly. Run these by hand when touching image-paste,
clipboard, or the contenteditable composer.

## Devices / platforms to cover

- Android — Gboard (primary keyboard)
- Android — Firefox (GeckoView; the reason the div swap exists at all)
- iOS Safari — PWA-installed or browser tab
- Desktop Chrome / Firefox (secondary; automated suite covers most of this)

---

## Test cases

### 1. Gboard clipboard history (Android)

Long-press in the composer to open the Gboard clipboard history tray.
Tap a previously-copied image.

**Pass:** a single attachment tile appears; no duplicate tiles; sending uploads the
image and it renders inline in the channel.

**Fail signal:** nothing stages, or a broken-image tile appears, or two tiles appear.

---

### 2. Screenshot → Share → paste (Android)

Take a screenshot. Use the system Share sheet to share it into the rivendell PWA,
or copy it from the Photos app and paste with long-press → Paste in the composer.

**Pass:** tile stages, image uploads, renders inline.

**Fail signal:** paste is silently swallowed (no tile, no error).

---

### 3. Browser "Copy image" → paste (desktop / Android Chrome)

Right-click (or long-press on mobile) any image on a web page and choose
"Copy image". Switch to rivendell and paste (Ctrl+V / long-press → Paste).

**Pass:** tile stages from the copied image data; sending uploads and renders it.

**Fail signal:** nothing appears, or the URL text is pasted instead of the image.

---

### 4. Screenshot → Copy → paste (iOS Safari)

Take a screenshot. Open Photos, tap Share → Copy Photo.
Switch to rivendell (PWA or Safari tab) and long-press → Paste in the composer.

**Pass:** tile stages; upload succeeds.

**Fail signal:** paste does nothing, or pastes a file path string.

---

### 5. Exclusivity — two paste attempts

Paste an image (channel 1 or 2 fires). Before sending, paste a second image.

**Pass:** second tile replaces the first (or both stage, depending on intended UX),
but exactly the number of uploads sent matches the number of tiles shown.

**Fail signal:** orphaned upload or tile count mismatch.

---

### 6. Remote-src `<img>` smuggled in (clipboard HTML)

Copy a web page section containing an `<img src="https://...">` and paste into
the composer.

**Pass:** no tile stages; text content (if any) pastes as plain text.

**Fail signal:** a tile appears pointing at a remote URL, or an upload is triggered
for bytes that were never on the local clipboard.

---

## After each test

Check the browser console for unhandled errors. Check the network tab to confirm
exactly one POST to `/api/uploads` per intended upload (no phantom requests).
