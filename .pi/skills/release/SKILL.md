---
name: release
description: Publish a pi-mobile release (version bump, notes, full perf on the S24 when the screen changed, tag, GitHub workflow, putting the official APK back on the phone, TestFlight for the iPhone). Use when the user asks to release or 發版.
---

# Release

Paths are from the repo root; `adb` is `~/Library/Android/sdk/platform-tools/adb`, the S24 is `$S`. The release
APK is not debuggable, so everything measured runs on a dev build of the same commit.

1. **Bump**: `npm version <x.y.z> --no-git-tag-version` (package.json and package-lock.json). Do it before the dev
   build: the dev build takes its versionCode from package.json (`0.11.3` → 1103), so it installs over the phone's
   current release and the official APK installs over it later. Android refuses a lower versionCode.
2. **Notes**: `docs/releases/<x.y.z>.md`, copied from the previous one: a one-line summary, the community notice, 下載
   (version numbers changed), 這一版有什麼 or 修正, 要注意. Written for users in zh-TW: what changed for them, not the
   code. The workflow uses this file as the release body.
3. **Dev build**: `./scripts/build-android.sh` writes `pi-mobile.apk` at the root; when that file is the user's,
   run its steps and copy `android/app/build/outputs/apk/release/app-release.apk` elsewhere instead. Install with
   `adb -s $S install -r <apk>`, then turn the accessibility service back on (an install turns it off):
   `node .pi/skills/device-testing/scripts/phone-screen.js on $S`, or the two `settings put secure` lines it runs; check
   `adb shell dumpsys accessibility` shows `Bound services:{Service[label=Pi`.
4. **Perf**, only when something since the last measured release changed what the screen does: check
   `git diff --stat v<last measured> HEAD -- src/app '*.css' android/app/src/main/java ios/App/App` and skip the
   step when nothing there touches rendering (a native plugin's data work does not), saying so in the release commit's
   body (`perf: skipped, nothing since v<last measured> changes the screen`). Otherwise every scene, 5 runs, against
   the last measured release's file in `test/perf/out/`:
   ```sh
   node test/perf/server.ts &
   node test/perf/fixture.ts setup $S
   node test/perf/run.ts --serial $S --label rel-<x.y.z> --compare test/perf/out/rel-<previous>.json
   node test/perf/fixture.ts teardown $S
   ```
   Unplug the charger first. If a scene stops with `pi is not in front` (a notification or the screen timing out),
   rerun only it: `--scenes panel --label rel-<x.y.z>-panel`. Known noise, not regressions: panel `rafP99` moving
   between 8.5 and 16.7/24 from one launch to the next; stream `gfxFrames` at about 1550 or about 2920; typing
   `gpuP99` 4950 (see docs/development.md § 效能量測). A real-looking regression is confirmed with fresh installs
   of both versions before anyone is told. Keep `rel-<x.y.z>.json`; delete other outputs.
5. **Commit and tag**: `npm run check`, then commit only package.json, package-lock.json and the notes as
   `chore(release): <x.y.z>`, `git tag v<x.y.z>`, `git push origin main v<x.y.z>`. The workflow
   (`.github/workflows/release.yml`) fails when the tag and package.json differ; it builds the APK and host binaries
   and publishes the release. Follow it with `gh run watch`.
6. **Phone back on the release**: `gh release download v<x.y.z> -p 'pi-mobile-*.apk'` into a scratch folder, compare
   its `shasum -a 256` with the digest GitHub shows (`gh release view v<x.y.z> --json assets`), install it with
   `-r`, turn accessibility on again, and check `dumpsys package dev.geminixiang.pimobile | grep versionName` has no
   `-dev`. Android phones update from the app itself: 設定's last line shows 更新到 <x.y.z> once the release is out.
7. **iPhone through TestFlight**: iOS has no in-app update and nothing iOS goes on GitHub; the iPhone takes the
   release from TestFlight. Upload from the Mac that holds the Apple signing identity (`security find-identity -v -p
   codesigning`), on a checkout of the tagged commit there (`git fetch --tags && git checkout v<x.y.z> && npm ci`).
   Codesign cannot reach a keychain locked in an SSH session (`errSecInternalComponent`): ask the user to unlock it
   on that Mac (`security unlock-keychain ~/Library/Keychains/login.keychain-db`), then run the script in its GUI
   session, e.g. `osascript -e 'tell application "Terminal" to do script "cd <repo> && TEAM=<team id>
   ./scripts/testflight-ios.sh > testflight.log 2>&1"'`, and read the log for `uploaded pi mobile`. The build
   number is the time, so a rerun of the same version uploads again. The build reaches the phone after App Store
   Connect finishes processing it (minutes); the user updates it in the TestFlight app.
