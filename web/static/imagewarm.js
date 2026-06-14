// imagewarm.js — best-effort image cache warming. Three jobs that prime the
// browser's HTTP/image cache so pictures paint without jank:
//   - preloadAvatars():        warm member-avatar URLs (channel switches paint instantly)
//   - warmViewportImages():    block the loading screen until visible images decode
//   - startBackgroundImageWarm(): sweep every channel's recent blob images in the background
//
// All three are pure cache priming — they have NO user-visible DOM contract (they
// only call new Image()/probe URLs), so they're not e2e-covered. The one piece
// with logic worth pinning is extractBlobUrls, the pure newest-first URL scan,
// unit-tested in web/test/imagewarm.test.js.
//
// State (warmGen, preloadedAvatars) is closure-encapsulated in createImageWarmer
// per the decomposition spine; the caller reaches in only through deps.

import { sidebarChannelOrder } from "./channelorder.js?v=__RIVENDELL_VERSION__";

// extractBlobUrls pulls up to `limit` /api/blobs/ paths from a messages array,
// walking newest-first as returned by the API. Pure: the only testable logic here.
export function extractBlobUrls(messages, limit) {
  const re = /!\[[^\]\n]*\]\((\/api\/blobs\/[a-f0-9]{64})\)/g;
  const urls = [];
  for (const msg of messages) {
    if (urls.length >= limit) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(msg.content)) !== null) {
      urls.push(m[1]);
      if (urls.length >= limit) break;
    }
  }
  return urls;
}

// WARM_IMAGES_PER_CHANNEL caps how many blob images are prefetched per channel
// in the background sweep. 5 covers what's visible in roughly two viewports.
const WARM_IMAGES_PER_CHANNEL = 5;

// createImageWarmer wires the three warming jobs to the app. Deps:
//   getState   — () => state (read fresh; state is reassigned on every update)
//   api        — for api.messages(channelId, {limit}) in the background sweep
//   avatarSrc  — (userId) => versioned avatar URL (lives in app.js; closes over
//                avatarVersion + state, so we take the function, not the value)
export function createImageWarmer({ getState, api, avatarSrc }) {
  // Keyed by the versioned avatarSrc URL, so a changed avatar (new ?v= token)
  // re-warms while unchanged ones are skipped — calling preloadAvatars repeatedly
  // is cheap.
  const preloadedAvatars = new Set();

  // warmGen is incremented each time startBackgroundImageWarm is called. In-flight
  // sweeps compare against it and abort when the value diverges (channel switched).
  let warmGen = 0;

  // preloadAvatars eagerly warms the browser HTTP cache for member avatars so they
  // paint instantly on channel switch instead of streaming in afterwards (which
  // looks janky). With a ~20-friend roster this is a handful of small images.
  function preloadAvatars() {
    const state = getState();
    for (const id in state.users) {
      const u = state.users[id];
      if (!u || !u.has_avatar) continue;
      const url = avatarSrc(u.id);
      if (preloadedAvatars.has(url)) continue;
      preloadedAvatars.add(url);
      const img = new Image();
      img.decoding = "async";
      img.src = url;
    }
  }

  // warmViewportImages prefetches images rendered in the active message list so
  // they're decoded before the loading screen is dismissed. Images with
  // loading="lazy" may not have started fetching yet (the overlay occludes layout
  // intersection), so we probe each src explicitly via new Image() to bypass lazy.
  // A 1.5 s timeout caps the wait so a slow CDN never pins the loading screen.
  async function warmViewportImages() {
    const wrap = document.getElementById("message-list");
    if (!wrap) return;
    const pending = [...wrap.querySelectorAll("img[src]")]
      .filter(img => !img.complete || !img.naturalWidth)
      .map(img => {
        const probe = new Image();
        probe.src = img.src;
        return new Promise(resolve => { probe.onload = resolve; probe.onerror = resolve; });
      });
    if (!pending.length) return;
    await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, 1500))]);
  }

  // startBackgroundImageWarm walks every channel in sidebar order (skipping the
  // active one, already warmed by warmViewportImages), fetches up to 20 recent
  // messages if not cached, then warms up to WARM_IMAGES_PER_CHANNEL blob images
  // per channel one at a time. Calling it again increments warmGen, which causes
  // any in-flight sweep to abort — so channel switches naturally reprioritize.
  async function startBackgroundImageWarm() {
    const gen = ++warmGen;
    for (const channelId of sidebarChannelOrder(getState())) {
      if (gen !== warmGen) return;
      const state = getState();
      if (channelId === state.activeChannelId) continue;
      let msgs = state.messages[channelId];
      if (!msgs) {
        try { msgs = await api.messages(channelId, { limit: 20 }); }
        catch { continue; }
        if (gen !== warmGen) return;
      }
      for (const url of extractBlobUrls(msgs, WARM_IMAGES_PER_CHANNEL)) {
        if (gen !== warmGen) return;
        await new Promise(resolve => {
          const img = new Image();
          img.onload = resolve;
          img.onerror = resolve;
          img.src = url;
        });
      }
    }
  }

  return { preloadAvatars, warmViewportImages, startBackgroundImageWarm };
}
