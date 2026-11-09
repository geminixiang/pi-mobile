---
name: architect
description: >-
  Settle the shape before code for non-trivial pi-mobile work (a new tool or toolset, a native plugin method, a rule shared by several tools, a module boundary): ground in the real code, sketch two or more structurally different designs, screen them for red flags, and bring one page to the user before implementing. Use for "architect this", "design this", or when jumping to code would lock in the wrong shape.
---

# Architect

Adapted from the `architect` skill in [pstack](https://github.com/cursor/plugins/tree/main/pstack/skills/architect) by Lauren Tan ([@poteto](https://github.com/poteto)), MIT License (`../PSTACK-LICENSE`). The method is hers; the pi-mobile specifics are ours. Here the user signs off before code: AGENTS.md says over-design needs the user's buy-in.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.

## 1. Ground

Build a real model of every part the change touches before sketching.

- Read the code, not your memory of it. Count and list from `git grep` (how many tools call it, which plugins check it, Android and iOS). A design doc that states a count must have run the search.
- Find what is stored: anything persisted by name (an extension name, a doc field) cannot be renamed without a migration.
- Note both platforms: `src/plugins/` contracts, `android/…/*.kt|java`, `ios/App/App/*.swift`, `test/plugins.snapshot.json` for what iOS implements.
- Ask the day-one question: if this requirement had been there from the start, what would we have built?

## 2. Sketch at least two shapes

Write the caller's usage first (a tool's `execute`, a native call, a component), then derive types and signatures, with `throw new Error("not implemented")` bodies. Two structurally different candidates at least, whole shapes rather than variations of one.

For a design that crosses several tools, plugins, or both platforms, get independent candidates or reviews from pi agents in Rex, each with a different lens (simplify, user and platform, implementation), told not to edit the repo:

```sh
rex new design-simplify -c "$PWD" -- pi --name design-simplify --exclude-tools edit "$(cat prompt-common.md lens-simplify.md)"
```

Each writes its answer to a file you named; wait for the files, read them, then `rex kill design-simplify …`. Give each the same grounding, the question, and the repo rules (AGENTS.md). Their disagreements are the signal.

Screen every candidate against [`references/design-red-flags.md`](references/design-red-flags.md). Prefer the one that hides more behind a smaller surface and leaves one owner per decision.

## 3. Agree

Write one page per [`references/rationale-template.md`](references/rationale-template.md) and stop for the user. Every tradeoff the user would feel is a question for them, not a line in a report. If the user pushes back on the shape, go back to step 1.

## 4. Implement against the sketch

The agreed sketch is the contract. A parameter or branch it did not anticipate is a signal to surface, not friction to absorb: was the sketch wrong, the requirement missed, or the code overreaching? Each step is its own commit with `npm run check` passing, and a fix comes with a test that fails on the old code.

## 5. Scrap when the shape is wrong

If implementation keeps producing friction the sketch cannot absorb, throw it out instead of bolting on fixes. Tells: the same workaround in unrelated places; edge cases that each need a special branch; casts or optional fields that are always set; callers that must know the abstraction's internal rules. Then re-ground, subtract before adding (the new sketch is smaller first), and sketch again.

## Report

End with 對未來的影響 (AGENTS.md § Structure): the red flags removed and added, and what is left for later.
