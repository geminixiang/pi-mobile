# Phone errands: implementation and evidence

Complete known navigation without a model round trip per screen. Only research #1, #2, #4, #5 and preview `note` are implemented; #3 is untouched. Execution stays native rather than splitting polling and targeting across JavaScript and Kotlin.

## Changes by file

Source references below; Kotlin files are under `android/app/src/main/java/dev/geminixiang/pimobile/` unless stated otherwise.

- `src/phone-screen/tool.ts:47`, `plugin.ts`: exclusive tap forms, defaults/bounds, native step union, optional `note` and snapshot `delta`. Existing steps and on-demand loading remain.
- `ScreenElements.kt:16`: per-display ids keyed by accessibility-node identity, label and surrounding text. Visible unchanged targets retain ids; missing/replaced targets retire them. Ids are not persistent across service restarts or screen departures. Card children remain separate lines.
- `ScreenActor.kt:145`: live lookup, nearest clickable ancestor's `ACTION_CLICK`, then refresh and gesture fallback within visible bounds. Coordinate taps remain gestures. A failed bounded open reports `app_not_open`.
- `ScreenNavigation.kt:16`: text taps wait 3 seconds; ambiguity stops. `wait_for` defaults to 3 seconds, capped at 10 by step conversion. `expect` requires every supplied condition. Matching ignores case: exact labels for taps, containment for observations, exact app name/package for expectations.
- `ScreenNavigation.kt:63`: search stops after 12 scrolls / 15 seconds or unchanged content. Selection prefers advertised direction, collection, then area. Testing caught the earlier implementation stopping at a collapsed header while its child list still scrolled.
- `ScreenText.kt`, `ScreenElements.kt:91`: one 300-character label limit; values versus hints, state/error/invalid markers, collection positions, scrolling and window headings. Traversal no longer stops at 161 lines. Output caps at 160; `more` counts observed omitted lines. Deadline expiry sets `slow`, so that count is not claimed as a complete total. `dialog/modal` uses root class or application-window height below 80%: a heuristic, not a universal modal signal.
- `PhoneScreenPlugin.kt:42`: per-display history. Changed package/keyboard/window headings, incomplete trees, or additions/removals exceeding half a list return full output; otherwise changed lines and `gone: [id]`. Reads always return full output.
- `PhoneScreenService.kt`, `ScreenChanges.kt`: event window ids map to their display; unresolved events never update another display's clock.
- `AgentScreenPlugin.kt`, `AgentPreview.kt` under `android/app/src/oss/`: pass `note` through `DisplayShell.before` to the existing progress label. No layout/animation changes.
- `test/phone-screen-steps.ts`, `android/agentscreen/test/{ScreenTextTest.kt,text.sh,errands.js}`: parser, pure native and device coverage. Interface snapshots, `docs/tools.md` log and research references updated.

## Model interface

```text
phone_read_as_user({screen?: background|front, screenshot?: boolean})
phone_act_as_user({steps, note?, screen?: background|front, screenshot?: boolean})

{action: "tap", id} OR {action: "tap", text} OR {action: "tap", x, y}
{action: "wait_for", text, gone?: false, ms?: 3000}
{action: "scroll_to", text, direction?: "down"}
{action: "expect", app?, text?}
```

Existing open, long_press, swipe, scroll, type, clear, key and wait remain. Failure stops subsequent steps. `note` is a few words in the user's language for batch progress.

## Measured token cost

`tiktoken` / `o200k_base`, not provider billing. Loaded definitions are compact JSON of actual name, description and parameters. Snapshot sizes include formatting, not request costs.

| Artifact | Before | After | Delta |
|---|---:|---:|---:|
| Loaded definitions, characters | 2917 | 2999 | +82 |
| Loaded definitions, tokens | 708 | 745 | +37 |
| Descriptions alone, tokens | 254 | 201 | −53 |
| Joined prompt sections, tokens | 2785 | 2785 | 0 |
| Prompt snapshot, bytes | 12463 | 12463 | 0 |
| Tool snapshot, bytes | 85532 | 86022 | +490 |
| Tool snapshot, tokens | 27267 | 27405 | +138 |

Both interface snapshots were updated with `--update`; prompt snapshot unchanged. Baselines: `/tmp/errands-evidence/`.

## Measured verification

Passed `npx tsc --noEmit`, `npm run check`, and:

```sh
cd android
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
./gradlew :app:assembleOssDebug :app:compileStoreDebugKotlin --console=plain -q
```

No project dependencies added. Pure tests use Gradle's cached compiler:

```sh
bash android/agentscreen/test/text.sh
node --import ./test/vite-imports.js test/phone-screen-steps.ts
```

The parser test fails against original `tool.ts` at `tap {id:12}`. Mutating back to the 60-character limit or shared timestamp fails native tests; restored implementation passes. Coverage includes hints/values, passwords, overflow, changed/gone/full output and display-event isolation.

After installing oss debug:

```sh
node .pi/skills/device-testing/scripts/phone-screen.js on emulator-5554
node android/agentscreen/test/errands.js
```

Only `emulator-5554`, existing pairing, Settings navigation, no setting toggles. Three fresh displays each completed one act:

```text
open Settings → tap Display & touch → wait_for Brightness level
→ scroll_to Colors → tap Colors → expect Settings / Colors → back
```

**5828 / 5846 / 5994 ms**, seven steps each, primary focus stayed display 0. Also passed stable ids, id/coordinate taps, stale/missing targets, present/absent/timeout waits, expectation failure stops, end-of-list detection, per-display history and preview note assertions. Cleanup closes the background display and returns to pi.

Background no-op taps, primary idle: **1274 / 1161 / 1161 ms**; primary repeatedly scrolling: **1142 / 1153 / 1129 ms**. Not a before/after S24 speed claim.

Evidence: `.shots/errands/{results.json,settle.json,note.png}` and `/tmp/errands-evidence/{device,check,gradle,native-tests,steps-red,text-red,settle-red}.log`.

## Not verified

No S24, model-driven natural-language run, provider billing, commercial errands, transaction flows or iOS runtime test. Semantic-click gesture fallback was not independently forced. Native dialog/error/hint coverage depends on app accessibility data. No transaction authorization was added; unattended errands are not claimed safe.

## 對未來的影響

One native tree owns ids/observations/targeting; one per-display clock owns settling. This removes coordinate-only chaining, shared display state and duplicated label limits. No persisted schema/toolset id changed. Safety gate #3, broader app coverage and S24 measurements remain separate.
