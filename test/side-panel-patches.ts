import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchSideDrawerBounds } from "../vite-plugins/side-drawer-bounds.ts";

function patched(file: string) {
	const path = new URL(`../node_modules/@base-ui/react/${file}`, import.meta.url).pathname;
	const source = readFileSync(path, "utf8");
	const result = patchSideDrawerBounds(source, path);
	assert(result);
	assert.equal(patchSideDrawerBounds(source, `${path}?v=dev-cache`), result);
	assert.throws(() => patchSideDrawerBounds("", path), /no longer apply/);
	assert.throws(() => patchSideDrawerBounds(source + source, path), /no longer apply/);
	return result;
}

const dismiss = patched("utils/useSwipeDismiss.mjs");
const start = dismiss.indexOf("let newOffsetX = initialTransformRef.current.x;");
const end = dismiss.indexOf("const previousOffset = dragOffsetRef.current;", start);
assert(start >= 0 && end > start);
const offset = new Function("initialTransformRef", "dampedDelta", "hasHorizontal", "hasVertical", "movementCssVars", "allowLeft", "allowRight", `${dismiss.slice(start, end)} return { x: newOffsetX, y: newOffsetY };`);
for (const initial of [-300, -10, 0, 10, 300]) {
	for (const delta of [-400, -10, 0, 10, 400]) {
		for (const direction of ["left", "right"]) {
			const result = offset({ current: { x: initial, y: 0 } }, { x: delta, y: 0 }, true, false, { x: "--drawer-swipe-movement-x" }, direction === "left", direction === "right");
			const expected = direction === "left" ? Math.min(0, initial + delta) : Math.max(0, initial + delta);
			assert.equal(result.x, expected);
		}
	}
}
assert.equal(offset({ current: { x: 0, y: 0 } }, { x: 15, y: -8 }, false, true, { x: "--drawer-swipe-movement-x" }, false, false).y, -8);
assert.equal(offset({ current: { x: 0, y: 0 } }, { x: 15, y: 0 }, true, false, { x: "--toast-swipe-movement-x" }, true, false).x, 15);

const opening = patched("drawer/swipe-area/DrawerSwipeArea.mjs");
const remainingStart = opening.indexOf("const remaining =");
const remainingEnd = opening.indexOf("const directionSign =", remainingStart);
assert(remainingStart >= 0 && remainingEnd > remainingStart);
const remaining = new Function("dismissDirection", "closedOffset", "dampedDisplacement", `${opening.slice(remainingStart, remainingEnd)} return remaining;`);
for (const direction of ["left", "right"]) {
	for (const displacement of [0, 150, 300, 320]) assert.equal(remaining(direction, 300, displacement), Math.max(0, 300 - displacement));
}
assert.equal(remaining("down", 300, 320), -20);
assert.equal(patchSideDrawerBounds("unrelated", "/src/app/SidePanel.tsx"), undefined);
console.log("side panel patches: opening, dismissal, interrupted transitions and unrelated gestures hold");
