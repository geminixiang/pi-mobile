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

- **Phone**: real measurements and real data. Approvals are always declined (`ask.mjs --decline`); calendar writes go
  only to the test calendar the user named; it may be locked or in use by another agent, so ask before using it.
- **Emulator** (`emulator-5554`): anything destructive, alarms and timers, root, filling the disk. Its numbers are
  not the phone's: measure on the phone before deciding on speed.
- Build and install: `./scripts/build-android.sh`, then `./scripts/run-android.sh <serial> <port>`. Both phone and
  emulator run the release build, which is not debuggable: `run-as` fails. On the emulator, `adb root` reads app data
  (`/data/data/dev.geminixiang.pimobile`); `adb unroot` after.

## Scripts

| Script | What it does |
|---|---|
| `forward.sh <serial> [port]` | Point the port at pi's DevTools socket. Needed again after a reinstall, restart, force stop, or `adb root`/`unroot`: the socket name carries the pid. |
| `find-adb-port.mjs <phone ip>` | Find the phone's wireless debugging port after it changed. |
| `ask.mjs "<question>" [--decline]` | Ask the open bot in natural words; prints tools called, approval dialogs, answer, seconds. Needs `CDP_PORT`. |
| `inject.mjs <port> [--gesture] <file.js>…` | Evaluate files in the page; for probes with a bundled library, or APIs that need a user gesture. |
| `startup-trace.mjs <port> [--log]` | Reload and time the start: when the transcript showed, and each native plugin call before it. |
| `resume-trace.mjs <port> <serial> <seconds away> [out]` | Leave pi (HOME, or `AWAY_APP=<package>`) and come back, tracing; `resume-analyze.mjs <out> [ms]` lists the long tasks. |
| `toolset-cost.sh <port> <toolset id>` | Prompt tokens one toolset adds to a short request. Every toolset at once: `test/tool-cost.sh`. |
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
