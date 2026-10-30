---
name: device-testing
description: Test and measure pi-mobile on an Android phone or the emulator over adb and DevTools. Use to ask a bot something as a user would, time the app's start or its return from the background, measure what a toolset costs, check the bot folder and its bash, or check that WebView storage survives.
---

# Device testing

The app runs in a WebView; everything here drives it over the Chrome DevTools Protocol (CDP) through a forwarded
port. Scripts are in `scripts/` next to this file; paths below are from the repo root. `test/device/ui.sh` (with
`test/device/ui.js`: `sleep`, `click(label)`, `type(text)`, `until(fn)`, `busy()`) runs one page function, and reads the port
from `CDP_PORT` (default 9333).

## Devices

- **Phone**: real measurements and real data. Nothing asks before a write, so a test question that writes (a calendar
  event, a reply, a schedule, a push, a database row) does it for real: ask only for writes the user agreed to, and
  undo them after. Calendar writes go only to the test calendar the user named; it may be locked or in use by another
  agent, so ask before using it.
- **Emulator** (`emulator-5554`): anything destructive, alarms and timers, root, filling the disk. Its numbers are
  not the phone's: measure on the phone before deciding on speed. A model gateway on this computer is
  `adb -s emulator-5554 reverse tcp:8317 tcp:8317` and `http://localhost:8317` in the app: pi refuses to send a key
  over plain HTTP to anything but loopback and Tailscale, so `10.0.2.2` no longer works.
- Build and install: `./scripts/build-android.sh`, then `./scripts/run-android.sh <serial> <port>`. It is signed with
  the release key, so it and a published release install over each other with the data kept; a device that still
  has a debug-key build must uninstall it first, which deletes the app's data. Both run the release build type,
  which is not debuggable: `run-as` fails. On the emulator, `adb root` reads app data
  (`/data/data/dev.geminixiang.pimobile`); `adb unroot` after.
- **iOS simulator**: `./scripts/run-ios.sh ["iPhone 18 Pro"]` builds, installs, opens, and starts
  `ios_webkit_debug_proxy` (Homebrew); then `WEBKIT=1 ./test/device/ui.sh '<async fn>'` drives it like the Android WebView.
  It uses Xcode through `DEVELOPER_DIR`, so `xcode-select` stays on the Command Line Tools. The simulator shares this
  computer's network: the gateway is `http://localhost:8317`. Screenshot with `xcrun simctl io booted screenshot`.
- **iPad** (iPad Air 5, iPadOS 26.7) and **iPhone** (iPhone 12 Pro, iOS 27.0.1, with Display Zoom: the page is 320
  points wide): plugged into the MacBook Air (`ssh geminixiang@yingmacbook-air`, `$MBA` below), which has Xcode and the
  paid Apple developer team `JJ5LYSJ566`. `~/pi-mobile-ios` there is not a checkout: it holds `ios/` and the two
  plugins `CapApp-SPM/Package.swift` points at. Build the web part here
  (`npx vite build && PI_MOBILE_DEBUG=1 npx cap sync ios`), then
  `rsync -az --delete --exclude build/ ios/ $MBA:pi-mobile-ios/ios/`, and the same for
  `node_modules/@aparajita/capacitor-secure-storage/` and `node_modules/@capacitor/app/`.
  Build there through `~/pi-mobile-ios/gui-run.sh "<command>"`, which runs it as a launchd job in the desktop
  session: over SSH the login keychain is locked and codesign fails with `errSecInternalComponent`. The command is
  `cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug -destination id=<UDID>
  -derivedDataPath build/device -allowProvisioningUpdates -allowProvisioningDeviceRegistration
  DEVELOPMENT_TEAM=JJ5LYSJ566 CODE_SIGN_STYLE=Automatic -quiet build`, with the UDID from
  `xcrun devicectl list devices`; the first build adds a new device to the team's profile. Install and open with
  `xcrun devicectl device install app --device <UDID> ios/App/build/device/Build/Products/Debug-iphoneos/App.app` /
  `process launch` there. To drive it from this Mac, run the CDP bridge on the MacBook Air and forward its port:
  `ssh $MBA 'nohup ~/.local/bin/uvx pymobiledevice3 webinspector cdp --native --port 9223 &'`, then
  `ssh -f -N -L 9223:localhost:9223 $MBA`; `CDP_PORT=9223 ./test/device/ui.sh` and `ask.js` work as on Android. The bridge
  exits at once with `Web Inspector is disabled` until 設定 › App › Safari › 進階 › 網頁檢閱器 is on.
  `--native` reaches the device through CoreDevice over USB or the local network alike; forwarding usbmuxd works only
  while it is on USB. Unplugged, the iPhone was not found on the MacBook Air's Wi‑Fi: keep it on the cable. Keep the
  MacBook Air awake (`caffeinate -dis`) and the device unlocked to launch pi. Screenshot there with
  `uvx pymobiledevice3 developer dvt screenshot --native <file>.png`. The gateway is this Mac's `*.ts.net` name
  (`http://geminixiangmac-mini.tail4f4249.ts.net:8317`): ATS blocks plain HTTP to `100.x`.
- **TestFlight**: on the MacBook Air run `~/pi-mobile-ios/gui-run.sh 'TEAM=JJ5LYSJ566 ./scripts/testflight-ios.sh'`
  from a checkout, for a build others install.

## Scripts

| Script | What it does |
|---|---|
| `forward.sh <serial> [port]` | Point the port at pi's DevTools socket. Needed again after a reinstall, restart, force stop, or `adb root`/`unroot`: the socket name carries the pid. |
| `find-adb-port.js <phone ip>` | Find the phone's wireless debugging port after it changed. |
| `ask.js "<question>"` | Ask the open bot in natural words; prints tools called, answer, seconds. Needs `CDP_PORT`. |
| `test/bash/run.ts` (from the repo root) | The phone folder's bash against GNU bash: 152 cases, a temporary bot, `0 regressions` or the cases that changed; `--accept` records the current differences as known. After a just-bash upgrade, a change to `vite-plugins/just-bash.ts`, or to `src/agent/files/`; see docs/research/just-bash.md. |
| `trace.js "<question>" [--image]` | Like `ask.js`, with the whole turn: each model call's time and tokens, each tool's arguments, result size, and time, and a SUMMARY line to compare runs before and after a change. Needs `CDP_PORT`; refuses unless the open bot is a test bot (name starting test, tmp, or 測試): create one per run. |
| `model-eval.sh <provider> <model>` | Ten everyday questions (weather, calendar, places, battery, steps, stocks, a table, a file and bash, a web search, a diagram) in a temporary bot on that model: one JSON line each with seconds, model requests, every tool call's code, tool errors, and the answer. For comparing a tool or prompt change on a weak model (Qwen3.6 on 0.11.2: about 90 s, 27 requests, 3 tool errors). Needs `CDP_PORT`. |
| `inject.js <port> [--gesture] <file.js>…` | Evaluate files in the page; for probes with a bundled library, or APIs that need a user gesture. |
| `startup-trace.js <port> [--log]` | Reload and time the start: when the transcript showed, and each native plugin call before it. |
| `resume-trace.js <port> <serial> <seconds away> [out]` | Leave pi (HOME, or `AWAY_APP=<package>`) and come back, tracing; `resume-analyze.js <out> [ms]` lists the long tasks. |
| `toolset-cost.sh <port> <toolset id>` | Prompt tokens one toolset adds to a short request. Every toolset at once: `test/device/tool-cost.sh`. |
| `phone-screen.js read\|act '<steps>'\|status\|on <serial>` | The phone-screen plugin without a model: what `read_phone_screen` sees (time, app, elements, screenshot size), or run `use_phone_screen` steps such as `'[{action:"open",app:"時鐘"}]'`. `on` turns the accessibility service on over adb. Needs `CDP_PORT`. See docs/research/phone-screen.md. |
| `phone-folder-check.js` | The bot folder on the phone and its bash, end to end: `CDP_PORT=<port> ./test/device/ui.sh "$(cat <it>)"`. |
| `storage-durability.sh <emulator> <port> [apk]` | Whether OPFS and IndexedDB survive a force stop, cache trims, an update, and a nearly full disk. Emulator only. |

## In the page

- `window.piRuntime`: `bots()`, `createBot({ name, job, avatar })`, `removeBot(id)`, `toolsets(id)`,
  `setToolset(id, toolset, on)`, `memory(scope)`, `saveMemory`, `phoneFolder(id)` (the bot's folder as an
  ExecutionEnv), `folderOf(id)`, `workspace(id)` (its sandbox folder), `hasSandbox`.
- `window.piController`: the open conversation (`id`, `subscribe(view => …)`, `setModel`, `setThinking`).
- `window.Capacitor.Plugins.<Name>`: the native plugins, e.g. `BotFiles`, `Triggers`, `Database`.
- Settings that are not secret are in `localStorage["pi-mobile.settings"]`; change one there and reload to test without
  it (keep the old value and put it back).

## Gotchas

- Clean up what a test makes: temporary bots (`removeBot` also deletes their folders), planted files, IndexedDB
  databases, OPFS entries.
- Simulating Android ending pi: `am kill` does nothing (the notification listener keeps the process important);
  `am force-stop` then `am start` does, and the pid changes.
- `adb root`/`unroot` restart adbd and drop every forward.
- Test with the words a user would say. Naming a tool tests nothing.
- One change at a time, measured before and after on the same device.
- A native tool goes in three layers, each working before the next: the plugin alone (`phone-screen.js`, a
  `Capacitor.Plugins` call), then the tool in a temporary bot asked in plain words, then the measurement. A model on a
  broken plugin only says "cannot"; the plugin call says why.
- Installing a build turns the accessibility service off (S24): `phone-screen.js on <serial>` after every
  `run-android.sh`, or `read` answers `off`. Apps that were open while it was switched on and off may stop answering
  it until force-stopped.
- When a turn ends while another app is in front, pi's foreground service stops and the WebView is hidden, so its
  timers stop: a `ui.sh` call into the page waits until pi comes back. The bot did not stall; the test did.
  `ask.js` and `trace.js` bring pi to the front once its AgentService is gone when `ANDROID_SERIAL` is set
  (`keep-front.js`); for a single `ui.sh` call, `adb shell am start -n dev.geminixiang.pimobile/.MainActivity` first.
- A screen-control question writes for real in the user's apps: use throwaway data (a note named pi 測試), undo it,
  and when the bot clears or deletes in bulk, read the confirmation it tapped ("2 個項目") to know nothing else went.
