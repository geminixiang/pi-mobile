import type { Plugin } from "vite";

const PATCHES = [
	{
		file: "utils/useSwipeDismiss.mjs",
		find: "      newOffsetX += dampedDelta.x;",
		replace: `      newOffsetX += dampedDelta.x;
      if (movementCssVars.x === '--drawer-swipe-movement-x') {
        if (!allowRight) newOffsetX = Math.min(0, newOffsetX);
        if (!allowLeft) newOffsetX = Math.max(0, newOffsetX);
      }`,
	},
	{
		file: "drawer/swipe-area/DrawerSwipeArea.mjs",
		find: "    const remaining = closedOffset - dampedDisplacement;",
		replace: `    const remaining = dismissDirection === 'left' || dismissDirection === 'right'
      ? Math.max(0, closedOffset - dampedDisplacement)
      : closedOffset - dampedDisplacement;`,
	},
];

export function patchSideDrawerBounds(code: string, id: string): string | undefined {
	const path = id.replace(/[?#].*$/, "");
	const patch = PATCHES.find(({ file }) => path.endsWith(`/node_modules/@base-ui/react/${file}`));
	if (!patch) return undefined;
	if (code.split(patch.find).length !== 2) throw new Error(`Base UI side drawer bounds no longer apply to ${patch.file}; revalidate the swipe paths before upgrading.`);
	return code.replace(patch.find, () => patch.replace);
}

export function sideDrawerBounds(): Plugin {
	return {
		name: "side-drawer-bounds",
		enforce: "pre",
		config: () => ({ optimizeDeps: { exclude: ["@base-ui/react"] } }),
		transform(code, id) {
			const patched = patchSideDrawerBounds(code, id);
			return patched === undefined ? undefined : { code: patched, map: null };
		},
	};
}
