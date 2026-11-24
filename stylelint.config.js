export default {
	extends: ["stylelint-config-recommended"],
	plugins: ["./stylelint/keyframes-compositor-only.js", "./stylelint/transition-no-layout.js", "./stylelint/no-side-stripe.js"],
	rules: {
		"pi-mobile/keyframes-compositor-only": true,
		"pi-mobile/transition-no-layout": true,
		"pi-mobile/no-side-stripe": true,
		"declaration-no-important": true,
		"selector-max-id": 0,
		"selector-max-compound-selectors": 4,
		"selector-max-specificity": "0,4,2",
		"no-duplicate-selectors": true,
		"no-descending-specificity": null,
		"property-disallowed-list": [["backdrop-filter"], { message: "backdrop-filter costs a GPU pass every frame the content under it moves; see the CSS skill" }],
		"declaration-property-value-allowed-list": [
			{
				"font-weight": ["400", "700", "inherit"],
				"border-radius": ["/^(?:0|inherit|var\\(--(?:radius-(?:sm|md|lg|xl|full)|card-radius)\\))(?: (?:0|var\\(--(?:radius-(?:sm|md|lg|xl|full)|card-radius)\\))){0,3}$/"],
			},
			{ message: "font-weight must be 400/700/inherit (Chinese fonts on Android have no 500/600), and border-radius must use one of the 6 tokens (--radius-sm, --radius-md, --radius-lg, --radius-xl, --card-radius, --radius-full, or 0/inherit)" },
		],
		"selector-class-pattern": ["^(?!(menu|group)$)", { message: "the .menu and .group boxes around lists are gone: put the list on the background with RowList (pi-mobile-ui/elements: .row-list, .list-label, rows); see DESIGN.md § Components" }],
		"selector-pseudo-class-disallowed-list": [["focus-visible", "active"], { message: (pseudo) => ({ active: "style a press with [data-pressed] (src/app/press.ts sets it at touch-down on Android and iOS alike); :active comes 100 ms late on Android and differently on iOS", "focus-visible": "a focus ring makes the app read as a web page; show focus with the element's own border or background, never a ring" })[pseudo.replace(/^:/, "")] }],
	},
};
