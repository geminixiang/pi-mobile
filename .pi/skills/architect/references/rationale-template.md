# Rationale template

Adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack/skills/architect/references/rationale-template.md) by Lauren Tan ([@poteto](https://github.com/poteto)), MIT License (`../../PSTACK-LICENSE`).

One page that ships with the sketch, in Traditional Chinese for the user (docs are zh-TW). Sentence-case headings. Replace each note with content.

## 問題

One paragraph: what we are doing, and what about the existing system makes the shape non-obvious. Name the constraints grounding found: types to interop with, callers that must not break, Android and iOS differences, stored data (a rename of a stored name needs a migration).

## 用起來的樣子

Write first. The caller's view: two or three real call sites (a tool's `execute`, a native method, a UI component) and what they get back. The shape below is derived from this; when they disagree, change the shape.

## 形狀

Data structures first, then how data flows through the signatures. Which invariants the types encode, where validation lives (`src/agent/parse.ts` at the boundary), what the design deliberately does not do. Judge interface depth: what the public surface hides and why it is no larger.

## 候選與取捨

The candidates (at least two structurally different), which one became the base, what was taken from the others, what was dropped and why. Red flags each candidate hit (`design-red-flags.md`).

## 接受的代價

One bullet per tradeoff: "we accept X in exchange for Y". Anything a reader might take for an oversight.

## 要你決定的

Questions for the user, phrased as questions with options and a recommendation. Every tradeoff the user would feel (latency, what gets blocked, a default) belongs here, not buried in the shape.

## 對未來的影響

Red flags this removes and adds; what it leaves for later.

## 第一步

The first thing to build once the user agrees. One sentence.
