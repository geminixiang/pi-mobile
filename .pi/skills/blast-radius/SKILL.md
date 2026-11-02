---
name: blast-radius
description: Find what a pi-mobile change could break beyond its diff (other tools, the other platform, stored data, the phone in the background) and prove the one fact it is safe because of by running real code. Use for "what could this break", before committing a change that touches a shared helper, a native plugin, a tool's name or rules, or stored names, or when reviewing a small diff you do not trust.
---

# Blast radius

Adapted from the `blast-radius` skill in [pstack](https://github.com/cursor/plugins/tree/main/pstack/skills/blast-radius) by Lauren Tan ([@poteto](https://github.com/poteto)), MIT License (`../PSTACK-LICENSE`). The method is hers; the pi-mobile specifics are ours.

Listing callers is not the job; `git grep` does that in a second. The job is the breakage grep does not show.

## Do not trust your own write-up

A write-up that sounds right reads the same whether or not it is true. Find the one or two facts the change's safety depends on and get each as far down this list as is cheap, then say where it stopped:

1. You said so. Worth nothing alone.
2. You pointed at the line: a real `file:line`, or the library's source in `node_modules`.
3. You walked the bad case step by step and it does not reach.
4. You ran it: a script, a node test, or `npm run check` with the old code put back.
5. You reproduced it on the phone: the emulator, or the S24 through `test/device/` (see the device-testing skill; tests stay silent).

## Where pi-mobile breaks out of sight

- **Stored names**: an extension name is stored per bot (`RENAMED` in `src/agent/toolsets.ts`); a tool name is stored in conversations and in tools a conversation loaded; doc fields and settings keys in storage.
- **The other platform**: a contract method iOS implements or not (`test/plugins.snapshot.json`); Android-only exceptions (an app with a bound accessibility service may start activities from the background, iOS has none).
- **Silent OS refusals**: Android drops a background `startActivity` without an error, so a tool reports success that never happened. Check before acting.
- **Who runs it**: a turn started by a schedule (`triggers.unattended`), pi in the background, the phone locked, another bot.
- **The model**: a renamed or reworded tool changes what the model picks; measure with natural questions in a temporary bot (docs/tools.md).
- **The app**: `src/app` branches on tool names; labels, steps, and previews.

## Steps

1. Read the change, including what it now does that the diff does not spell out.
2. Find the one fact it is safe because of, and spend the time there, not on a long list of maybes.
3. Look where grep stops: the list above, the library source and its pinned version, timing (background, unmount, resume).
4. For each risk: how it breaks, `file:line`, how likely, how bad, how to check. Keep the confirmed ones; list the cleared ones separately.
5. Prove the one fact by running code, and paste what happened.
6. For a wide change, ask pi agents in Rex with different lenses (see the architect skill); different models catch different real bugs.

## Reply

What it does (including the non-obvious part); the one fact it is safe because of, with the step it reached and the proof, or "unproven"; risks; cleared; the cheapest test that catches the real bug before it ships.
