# Cross-browser e2e smoke (WebKit + Gecko)

The main e2e suite runs under Chromium (its WebRTC specs depend on Chromium's
fake-capture stack). Two opt-in smoke specs boot the whole client under the other
two engines to catch regressions Chromium can't see — WebKit (Safari) below, and
Firefox (Gecko) in its own section. Both are dev-only and gated behind an env flag;
neither completes a real call.

## WebKit (Safari engine)

`web/e2e/webkit-smoke.spec.js` runs the client under Playwright's **WebKit**
build — the closest thing to Safari that runs headless on Linux. Its job is to
catch Safari-only regressions (a feature WebKit parses but won't run, a
getUserMedia lead-up that throws) that the Chromium suite can't see, since the
WebRTC specs depend on Chromium's fake-capture stack. It boots the whole app
with zero uncaught page errors, exercises the `voice.js` media-environment
helpers in-page, and probes that `getUserMedia` *settles* (resolve or named
rejection) rather than hanging. It does **not** complete a real call.

### Opt-in by design

WebKit needs a sizeable native stack that Debian/Ubuntu CI images carry but most
dev boxes don't. So the project is gated behind `E2E_WEBKIT=1`:

```
make test-e2e                 # Chromium only — green on any host
E2E_WEBKIT=1 make test-e2e    # adds the WebKit smoke (host must be provisioned)
```

On a Debian/Ubuntu host the provisioning is just `npx playwright install-deps
webkit`. Everything below is for **RHEL-family hosts** (AlmaLinux/Rocky/Fedora),
where `install-deps` doesn't apply. This box automates it via a git-ignored
`scripts/webkit-e2e-host-setup.local.sh`, invoked from `Makefile.local`.

### What a RHEL-family host needs (WebKit only)

1. **Native libraries** (dnf; CRB + EPEL enabled):

   ```
   sudo dnf install -y \
     cairo cairo-gobject enchant2 fontconfig gdk-pixbuf2 graphene \
     gstreamer1 gstreamer1-plugins-base gstreamer1-plugins-good \
     gstreamer1-plugins-bad-free-libs gstreamer1-plugin-libav pipewire-gstreamer \
     gtk4 harfbuzz-icu hyphen lcms2 libatomic libavif libepoxy libglvnd-gles \
     libicu libjpeg-turbo libmanette libsecret libwayland-client libwayland-egl \
     libwayland-server libwebp libxslt opus pango woff2 vulkan-loader \
     pulseaudio-utils pipewire pipewire-pulseaudio wireplumber
   ```

   `gstreamer1-plugins-good` (`pulsesrc`) and `pipewire-gstreamer`
   (`pipewiresrc`) are the easy ones to miss — without them WebKit's GStreamer
   capture path can't see the audio device and getUserMedia throws
   `InvalidStateError: Failed to start the audio device`.

2. **A jpeg-8 ABI libjpeg.** Playwright's WebKit is built against Ubuntu's
   `libjpeg.so.8` (symbol version `LIBJPEG_8.0`). RHEL's libjpeg-turbo ships only
   the jpeg-6.2 ABI (`libjpeg.so.62`), and a symlink does **not** work — the
   versioned symbol is genuinely absent. Build libjpeg-turbo with `-DWITH_JPEG8=1`
   and drop the result **into the WebKit bundle** (leave the system jpeg alone):

   ```
   cmake -S libjpeg-turbo-<ver> -B build -DWITH_JPEG8=1 -DCMAKE_BUILD_TYPE=Release
   make -C build jpeg
   cp build/libjpeg.so.8.* \
     ~/.cache/ms-playwright/webkit-*/minibrowser-wpe/lib/libjpeg.so.8
   ```

   The bundle's libs resolve siblings via their run path, so the drop-in is
   picked up at launch. A Playwright version bump installs a fresh bundle and
   wipes the drop-in — re-copy it (the setup script does this every run).

3. **A capture device.** Headless boxes have no audio source, so run a user-level
   PipeWire stack with one virtual source:

   ```
   export XDG_RUNTIME_DIR=/run/user/$(id -u)
   pipewire & wireplumber & pipewire-pulse &
   pactl load-module module-null-sink     sink_name=vsink
   pactl load-module module-virtual-source source_name=vsource master=vsink.monitor
   pactl set-default-source output.vsource
   ```

4. **Skip Playwright's pre-launch host check.** It hard-fails on `libx264.so`
   (H.264 encode, RPMFusion-only), which this audio-only smoke never exercises:

   ```
   export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
   ```

With all four in place the smoke passes: `getUserMedia` settles with
`NotAllowedError` (headless WebKit denies permission — a clean settle, not a
hang) and no uncaught page errors.

## Firefox (Gecko engine)

`web/e2e/firefox-smoke.spec.js` is the Gecko counterpart, gated behind
`E2E_FIREFOX=1` (`make test-e2e` adds the project; this box sets the flag in
`Makefile.local`). It does the same job under Firefox — boot the whole client
with zero uncaught page errors, run the `voice.js` media-environment helpers
in-page, and prove `getUserMedia` *settles* rather than hanging — to catch
Gecko-only regressions (contenteditable image delivery, the Shift+Enter `<br>`
normalize, the FF-Android freeze) that the Chromium suite can't see.

Unlike WebKit, **Gecko needs no native provisioning** on Linux: Playwright's
Firefox bundle is self-contained, so there's no host-setup hook — `Makefile.local`
just flips `E2E_FIREFOX`. If a freshly downloaded Firefox won't launch on a
RHEL-family host, run `cd web && npx playwright install-deps firefox` once
(expected to be unnecessary).
