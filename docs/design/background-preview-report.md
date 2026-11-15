# Background screen preview — emulator report

Implemented in the scratch worktree; no commit or push. Only `emulator-5554` was used (Android 16, API 36, 1080×2400). Evidence is under `.shots/preview/`.

## Design as built

The purpose is to inspect the bot’s current app and continue its existing task without returning to pi.

`android/agentscreen/` owns the display, H.264 transport, codecs, and takeover outcome. `android/app/src/oss/java/dev/geminixiang/pimobile/AgentPreview.kt` owns the native window. The store edition has no dependency on this module.

The display is 352×800 with proportional density. Attaching a small encoder Surface to the original full-resolution display cropped the image in the first device experiment; reducing the display itself avoids another scaling/compositing pipeline. Screen coordinates remain normalized through the existing 540-point tool interface.

`watch on <generation>` starts a Surface-input AVC encoder: 15 fps maximum, 250 kb/s CBR target, ten-second keyframe interval, repeated frames disabled. Binary stdout packets contain generation, length, presentation timestamp, flags, and encoded bytes. Stdin remains the control channel. `watch off` releases the encoder and returns the display to its low-resolution ImageReader. Generation tags keep old packets out of a replacement decoder.

Pi decodes directly to a TextureView, without Bitmap/JPEG/base64 or WebView video. The 136-dp-wide, rounded warm-paper accessibility overlay shows the current native action in Traditional Chinese. Dragging docks it to a corner; tapping the video takes over; × hides it without stopping automation. It is non-focusable and non-touch-modal. Codec failures appear in its action line, with diagnostics in logcat.

Takeover finds the visible root task on the background display, executes `am display move-stack <id> 0`, and verifies the same task is on display 0. Subsequent reads/actions return a normal snapshot with `error: "taken_over"`; actions report `done: 0`. Retrying `open` does not silently resume automation. Explicit close/open starts another session.

The shared seam is limited to `DisplayShell`: accessibility-service attachment, action progress, stop reasons, and serialization of actions against takeover. `PhoneScreenPlugin` now reads the target display’s metrics and returns stopped snapshots without bridge exceptions. These changes are necessary because only the existing screen code owns accessibility and executes bot actions; the shared code still knows nothing about adb, codecs, or the preview.

## Measured

`android/agentscreen/test/measure.js` ran three repetitions of still, hidden, and continuously scrolling Settings. Each CPU sample uses `top -b -d 1 -n 21`; the first sample is discarded, leaving twenty one-second samples. 100% means one CPU core. The measured shell PID is **app_process**, not its parent `sh`.

| State | pi CPU, run means | DisplayServer CPU, run means |
|---|---|---|
| Still preview | 0.15 / 0 / 0.10% | 0 / 0.10 / 0.05% |
| Hidden preview | 0.10 / 0.10 / 0.05% | 0 / 0 / 0% |
| Continuous scroll | 23.01 / 22.79 / 23.14% | 1.14 / 1.08 / 1.00% |

The separate `media.swcodec` process used 22.10 / 17.35 / 16.99% during scrolling. Emulator encoding is software (`c2.android.avc.encoder`); decoding uses `c2.goldfish.h264.decoder`.

- First rendered-frame callback: **662 / 977 / 735 ms** in the three still runs. Timing starts during decoder setup, includes launching Settings, and excludes discovery/display creation and initial codec allocation.
- Encoded-frame/byte counter deltas over approximately twenty seconds of scrolling: **14.97 / 14.06 / 15.02 fps**, **546 / 363 / 574 kb/s** H.264 payload. The bitrate target is not a measured ceiling; shell/TLS overhead is excluded.
- Still sessions emitted no further frames for **23.42 / 23.95 / 24.00 seconds** before hiding.
- `dumpsys meminfo -s`: warmed pi **112–113 MiB PSS**, shell **88 MiB**, software codec **19 MiB**. Hidden: pi **112 MiB**, shell **88 MiB**, codec **13 MiB**. The cold pi sample was **191 MiB**. These are process totals, not isolated incremental allocations.

Raw counters, top samples, memory dumps, and codec-removal events are saved alongside the screenshots.

## Verification and limits

Ran the requested OSS APK build and store Kotlin compilation, `npm run check`, and `node android/agentscreen/test/preview.js`. The device test verifies repeated starts, normalized taps, dragging, main-display focus, outside touches, hide-and-continue, same-task/same-page takeover, and named read/action outcomes. Screenshots: `overlay-home.png`, `dragged.png`, `outside-touch.png`, `taken-over.png`, `hidden.png`.

A shutdown regression test failed before the cleanup wait and passed afterward: app_process must not exit while its frame thread is still releasing the display. Both logs are retained.

Unverified: API 37/OEM behavior, physical-phone battery use, lock-screen/rotation behavior, secure-content apps, long sessions, and a live-model conversation. S24 was not touched. Takeover waits for an in-flight action, potentially a ten-second wait step. Progress describes native actions, not the model’s higher-level intent. Hidden/taken-over sessions have no new resume UI. Low battery cost on hardware is an inference, not a measurement.

Reproduce with the installed debug app, accessibility enabled, and wireless debugging paired:

```sh
(cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew :app:assembleOssDebug :app:compileStoreDebugKotlin --console=plain -q)
node android/agentscreen/test/preview.js
node android/agentscreen/test/measure.js
npm run check
```

The emulator’s previous release signature required reinstalling. Its data was backed up to `/tmp/pi-preview-original-data.tar` (0600); its pairing key was restored to the debug app.

## 對未來的影響

Removed the main-display-size assumption and kept video out of React. Added one edition-neutral lifecycle/action seam, one framed protocol, and dependence on Android’s shell task-list format. No new tools, permissions, or TypeScript plugin methods. Device scripts exercise the real implementation; hardware qualification and a user-facing resume/session lifecycle remain future work.
