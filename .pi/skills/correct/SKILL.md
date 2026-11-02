---
name: correct
description: Find the mistakes agents keep repeating in pi-mobile and make each one impossible, trying architecture first, then types, then a check in npm run check whose error names the fix, then a test, and prose last; prove each check fails on a real past mistake and record it in the AGENTS.md rule table. Use when the user corrects the same kind of mistake again, or asks to make a class of mistakes impossible.
---

# Correct

Adapted from the `correct` skill in [pstack](https://github.com/cursor/plugins/tree/main/pstack/skills/correct) by Lauren Tan ([@poteto](https://github.com/poteto)), MIT License (`../PSTACK-LICENSE`). The method is hers; the pi-mobile specifics are ours.

The user keeps correcting agents for the same mistakes. Change the repo so the next agent cannot make them. Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles.

## Find the mistake classes

Read the evidence, not your impression:

- `git log` (reverts, `fix(` commits, a change undone a day later), the 紀錄 tables in `docs/tools.md` and other docs;
- the memory files with `type: feedback` (the user's corrections), AGENTS.md;
- the code itself, for the red flags in `../architect/references/design-red-flags.md`.

Group them into classes. A class counts once it has happened twice.

## Fix each class at the highest level that works

1. **Architecture**: one owner per state and decision, one supported way per task, internals out of reach (an owner function others call), one source of truth with the rest derived. Delete the old way in the same change, or agents keep copying it.
2. **Types**: the bad state cannot be written (a discriminated union, a required field, `defineAppTool` declarations).
3. **A check in `npm run check`**: `test/code-rules.ts` (source patterns, owned internals), `test/tools-node.ts` (tools, names, the tool map), `test/plugins-node.ts` (native contracts), or a contract in `test/contracts/`. The error names the file or function to use instead.
4. **A test of behavior**: through the `Platform` seam, or a device script under `test/device/` when only the phone shows it.
5. **Prose last**, only for judgment calls; nothing fails when an agent skips it.

## Fix and prove

One commit per class. Prove each new check fails on the real past mistake: put the old code back (or a minimal copy of it), run the check, paste the failure, restore. A check that passes on the mistake is not done.

Exceptions sit on the line with a `// why:` and the user's approval.

## Keep the rule table

The table at the end of AGENTS.md § Structure pairs each rule with what enforces it. Add a row for each class you fix. When the user corrects you on a rule already in the table that only review enforces, that is a repeat: fix it at the highest level in the same change. Drop a row once its mistake cannot happen.

**Reply**: each class with its evidence (commits, `file:line`), the level picked and why a higher one did not work, the proof that the check fails on the old code, and 對未來的影響.
