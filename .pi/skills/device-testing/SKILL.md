---
name: device-testing
description: Test and measure pi-mobile on an Android phone or the emulator over adb and DevTools. Use to ask a bot something as a user would, time the app's start or its return from the background, measure what a toolset costs, check the bot folder and its bash, or check that WebView storage survives.
---

# Device testing

The app runs in a WebView; everything here drives it over the Chrome DevTools Protocol (CDP) through a forwarded
port. Scripts are in `scripts/` next to this file; paths below are from the repo root. `test/ui.sh` (with
`test/ui.js`: `sleep`, `click(label)`, `type(text)`, `until(fn)`, `busy()`) runs one page function, and reads the port
from `CDP_PORT` (default 9333).

## Devices

- **Phone**: real measurements and real data. Nothing asks before a write, so a test question that writes (a calendar
  event, a reply, a schedule, a push, a database row) does it for real: ask only for writes the user agreed to, and
  undo them after. Calendar writes go only to the test calendar the user named; it may be locked or in use by another
  agent, so ask before using it.
- **Emulator** (`emulator-5554`): anything destructive, alarms and timers, root, filling the disk. Its numbers are
  not the phone's: measure on the phone before deciding on speed.
- Build and install: `./scripts/build-android.sh`, then `./scripts/run-android.sh <serial> <port>`. It is signed with
  the release key, so it and a published release install over each other with the data kept; a device that still
  has a debug-key build must uninstall it first, which deletes the app's data. Both run the release build type,
  which is not debuggable: `run-as` fails. On the emulator, `adb root` reads app data
  (`/data/data/dev.geminixiang.pimobile`); `adb unroot` after.

## Scripts

| Script | What it does |
|---|---|
| `forward.sh <serial> [port]` | Point the port at pi's DevTools socket. Needed again after a reinstall, restart, force stop, or `adb root`/`unroot`: the socket name carries the pid. |
| `find-adb-port.js <phone ip>` | Find the phone's wireless debugging port after it changed. |
| `ask.js "<question>"` | Ask the open bot in natural words; prints tools called, answer, seconds. Needs `CDP_PORT`. |
| `test/bash/run.ts` (from the repo root) | The phone folder's bash against GNU bash: 152 cases, a temporary bot, `0 regressions` or the cases that changed; `--accept` records the current differences as known. After a just-bash upgrade, a change to `vite-plugins/just-bash.ts`, or to `src/agent/files/`; see docs/research/just-bash.md. |
| `trace.js "<question>" [--image]` | Like `ask.js`, with the whole turn: each model call's time and tokens, each tool's arguments, result size, and time, and a SUMMARY line to compare runs before and after a change. Needs `CDP_PORT`; refuses unless the open bot is a test bot (name starting test, tmp, or 測試): create one per run. |
| `inject.js <port> [--gesture] <file.js>…` | Evaluate files in the page; for probes with a bundled library, or APIs that need a user gesture. |
| `startup-trace.js <port> [--log]` | Reload and time the start: when the transcript showed, and each native plugin call before it. |
| `resume-trace.js <port> <serial> <seconds away> [out]` | Leave pi (HOME, or `AWAY_APP=<package>`) and come back, tracing; `resume-analyze.js <out> [ms]` lists the long tasks. |
| `toolset-cost.sh <port> <toolset id>` | Prompt tokens one toolset adds to a short request. Every toolset at once: `test/tool-cost.sh`. |
| `phone-screen.js read\|act '<steps>'\|status\|on <serial>` | The phone-screen plugin without a model: what `read_phone_screen` sees (time, app, elements, screenshot size), or run `use_phone_screen` steps such as `'[{action:"open",app:"時鐘"}]'`. `on` turns the accessibility service on over adb. Needs `CDP_PORT`. See docs/research/phone-screen.md. |
| `phone-folder-check.js` | The bot folder on the phone and its bash, end to end: `CDP_PORT=<port> ./test/ui.sh "$(cat <it>)"`. |
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
