# Screen-share throughput/quality investigation

Date: 2026-06-29. Author: Claude (investigation per Rob's request after the first
real-world desktop-sharing test went badly — "couldn't get it to stream in a
reasonable resolution at all"; audio was immaculate). Originally a findings + options
memo, not a patch.

> **STATUS — IMPLEMENTED (2026-06-30, branch `screen-share-throughput`).** All of
> options A–F below were actioned. The concrete values chosen and the load-bearing
> invariants now live in [video.md](video.md) (the source of truth); this memo is kept
> for the reasoning trail. In brief: **A** screen ceiling `SCREEN_MAX_BITRATE_BPS`
> = 2.5 Mbps + `SCREEN_TOTAL_UPLINK_BPS` = 4.5 Mbps (camera path untouched); **B** screen
> res ladder rescaled to the new ceiling (native ≥1.6M, ½ 600k–1.6M, ¼ <600k); **C** the
> bandwidth soft ceiling learns from `linkStressed` (loss/RTT) only, decoupled from a
> CPU-pinned encoder; **D** `orderVideoCodecsVP9First` for screen senders; **E** screen-
> scoped recovery steps (+150k target / +20k soft ceiling) scaled to the wider range, with
> the `CLIMB_AFTER_HEALTHY` gate + soft ceiling unchanged; **F** capture confirmed native
> (resolution left unconstrained — the downscale is the adaptive ladder's alone).

## TL;DR

Desktop screen share is starved by **two compounding caps that were sized for phone
camera video, not for a high-resolution desktop**, plus a codec choice that is the
worst possible one for text:

1. **The per-sender ceiling is 800 kbps** (`VIDEO_MAX_BITRATE_BPS`). That is the
   *hard* upper bound even on a flawless wired link in a 2-party DM. 800 kbps for a
   1080p/1440p/4K desktop is far too low — industry screen-share targets are ~1.5–3
   Mbps. So even in the best case the picture is soft, and that's *before* congestion
   control touches anything.
2. **Native resolution is gated at ≥700 kbps** (`VIDEO_SCALE_SCREEN_FULL_BPS`), i.e.
   within 100 kbps of the 800 kbps ceiling. The AIMD controller almost never stays in
   that top 100 kbps band, so the share spends nearly its whole life at ½ scale (540p
   from 1080p) or ¼ scale (270p) — exactly the "no reasonable resolution" report.
3. **VP8 is forced first** (`orderVideoCodecsVP8First`). VP8 has no screen-content
   coding tools; VP9/H.264/AV1 render text dramatically sharper at the same bitrate —
   which matters *most* exactly when bitrate is scarce.

Audio was immaculate because audio rides its own m-line with no bitrate cap and is
cheap; all the constraints land on the video pipe.

The good news: the dangerous, well-documented invariant — **don't speed up the AIMD
climb / don't remove the soft ceiling** (it prevents the marginal-*phone*-wifi call
drop, see `docs/design/video.md`) — is about a **phone camera on flaky wifi**. Screen
sharing is **desktop-only by nature**, a different network/CPU profile. We can give
screen its own, more generous profile without touching the phone-camera path that the
invariant protects.

## How the pipe is actually shaped (the math)

For the common case — a 2-party DM desktop share:

- `bitrateCapFor(2, "video")` = `min(800k, TOTAL_VIDEO_UPLINK_BPS/1)` =
  `min(800k, 1600k)` = **800 kbps**. The 1600 kbps roster budget never helps the DM
  case; the 800 kbps per-sender ceiling binds first.
- Screen resolution ladder (`videoScaleForTarget(target, isScreen=true)`):
  - `≥ 700k` → **1× native**, 30 fps
  - `350k–700k` → **2× (¼ pixels)**, 30 fps
  - `< 350k` → **4× (1/16 pixels)**, 24–30 fps
- So **native res lives only in the 700–800 kbps band — the top 12.5% of the budget.**

Now trace a real call. Target starts at the ceiling (800k → native). The moment a
*single* stressed sample arrives (≥8% loss, ≥600 ms RTT, **or `qualityLimitationReason
=== "cpu"`**):

- `congestionTarget`: target ×= 0.75 → **600k** → drops below 700k → **½ scale**.
- `softCeilingFor`: soft ceiling ratchets to `0.85 × 800k` = **680k** — now *also*
  below the 700k native threshold.
- Recovery: soft ceiling re-probes at **+5 kbps per 2.5 s interval** (~2 kbps/s) and
  only while healthy; target climbs at **+40 kbps**, but only after a 4-interval
  (~10 s) healthy streak. To get back to native you need the soft ceiling to crawl
  680k→700k (≥4 clean intervals) **and** the target to climb 600k→700k (≥3 climb
  steps, each gated by a 4-interval streak) — call it **30+ seconds of a flawless
  link**, with any single blip resetting it.

Net effect: a desktop share realistically parks at **½ scale (≈540p) at ≤800 kbps**,
sliding to ¼ under any sustained loss. That is the user-visible "couldn't get a
reasonable resolution at all."

## Root-cause ranking

### #1 — The 800 kbps ceiling is too low for desktop content (dominant)

`VIDEO_MAX_BITRATE_BPS = 800000` and `TOTAL_VIDEO_UPLINK_BPS = 1600000` were sized for
"~360p-class camera video" on phone uplinks for ~20 friends. Screen content is a
different beast: high native resolution, lots of high-contrast text/edges where bitrate
buys legibility. 800 kbps simply cannot carry a crisp 1080p+ desktop, congestion
control or not.

### #2 — Native res is unreachable in practice (the ladder is gated at the ceiling)

Because `VIDEO_SCALE_SCREEN_FULL_BPS = 700k` sits 100 kbps under the 800 kbps ceiling,
native res only happens at the very top of the budget. Combined with the AIMD + soft
ceiling (which immediately ratchets to 680k on any stress), the controller is
structurally biased *against* ever holding native res. The ladder thresholds need to
scale with whatever the new ceiling is, so native lives across a broad band, not a
sliver.

### #3 — CPU-limited is conflated with "the link broke"

`uplinkStressed` treats `qualityLimitationReason === "cpu"` the same as loss/RTT, so a
CPU-bound encoder both (a) drops resolution — *correct* relief for CPU — **and** (b)
ratchets the bandwidth *soft ceiling* down as if the link failed, which then pins
bitrate low long after the CPU spike passes. A desktop encoding a 1080p/1440p/4K screen
at 30 fps in **software VP8**, separately per mesh peer, hits CPU limitation routinely.
So a busy encoder can permanently park the bandwidth even when the network was never
the problem. CPU relief and link-capacity learning should be decoupled.

### #4 — VP8-first is the wrong codec for text

VP8 lacks screen-content coding; VP9/H.264 are markedly sharper on text at equal
bitrate. VP8-first was chosen as a *safe cross-browser default* and explicitly **does
not** fix the FF-Android freeze (that's an upstream FF-*Android* encoder bug — and a
phone won't be the one screen sharing). All desktop browsers (Chrome/Firefox/Safari)
support VP9, so preferring VP9 *for screen content* is a low-risk, orthogonal win where
bitrate is scarcest.

## Options (ranked; none applied)

**A. Give screen its own, higher bitrate budget (biggest lever).** Introduce a
screen-specific ceiling (e.g. `SCREEN_MAX_BITRATE_BPS` ≈ 2.0–2.5 Mbps) and a higher
screen uplink total, selected when `videoIsScreen`, leaving the camera/phone path at
800 kbps untouched. Desktop uplinks are typically far better than phone uplinks, and
the DM (2-party) case — the most common share — has the whole pipe to itself.

**B. Rescale the screen resolution ladder to the new ceiling.** Make native res
reachable across a broad band (e.g. native ≥ ~60–70% of the new ceiling, ½ across a
wide middle, ¼ only at the true floor), so the controller can actually *hold* native on
a decent link instead of pinning ½. This must move together with (A).

**C. Decouple CPU-limited from the soft-ceiling ratchet.** Let `cpuLimited` drop
resolution/framerate (its real relief) but **not** ratchet the bandwidth soft ceiling —
only loss/RTT should teach "the link breaks here." Stops a busy encoder from
permanently pinning bitrate.

**D. Prefer VP9 for screen content on desktop senders.** Keep VP8 for camera / as
fallback; this is orthogonal to the FF-Android freeze. Sharper text at the same bitrate
is exactly what helps when the pipe is tight.

**E. A less pessimistic recovery profile for screen (carefully).** The 30 s+ recovery
asymmetry is right for a phone camera on marginal wifi (prevents the call-drop
sawtooth). A desktop on ethernet shouldn't need 30 s to restore resolution after one
blip. A faster soft-ceiling re-probe **scoped to the screen path only** would help —
but this is the one option that brushes against the documented don't-touch invariant,
so it should be screen-scoped and tested deliberately, last.

**F. Verify capture + render aren't silently downscaling.** Confirm `getDisplayMedia`
is delivering full native resolution (some browsers default display capture lower; the
`frameRate: {ideal:30}` is set but there's no resolution hint), and that the receiver
`<video>` tiles aren't a smaller bottleneck than the stream. Cheap to check, rules out
a non-bitrate cause.

## Suggested sequencing

1. **A + B + D together** — raise the screen ceiling, rescale the ladder to match, and
   prefer VP9 for screen. This trio should move the needle the most and is low-risk
   (camera/phone path untouched).
2. **C** — decouple CPU from the bandwidth soft ceiling.
3. **F** — verify capture/render aren't a separate bottleneck.
4. **E** — only if still parking too low after the above; screen-scoped, tested against
   the marginal-link drop.

## Guardrails / what NOT to break

- The **camera / phone AIMD path and its soft ceiling stay as-is** — they prevent the
  marginal-wifi call drop documented in `docs/design/video.md`. Everything above is
  scoped to the screen path (`videoIsScreen`), which is desktop-only.
- Tests that pin current behavior and will need updating with any change:
  `web/test/voice.test.js` (`videoScaleForTarget`/`bitrateCapFor`/`detectScreenMotion`
  cases) and `web/e2e/screen-share.spec.js` (contentHint motion↔detail switch,
  share→receive→camera-swap→teardown). The `degradationPreference` and `contentHint`
  motion-vs-detail logic is sound and should be preserved.
- Mesh has no SFU; per-sender cost is paid (N-1)× on the uplink. A higher screen
  ceiling is safe in a 2-party DM but must still shrink with roster size for group
  shares — keep the `bitrateCapFor` budget split, just with a higher screen total.
