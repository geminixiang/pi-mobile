export default {
	extends: ["stylelint-config-recommended"],
	plugins: ["./stylelint/keyframes-compositor-only.js", "./stylelint/transition-no-layout.js"],
	rules: {
		"pi-mobile/keyframes-compositor-only": true,
		"pi-mobile/transition-no-layout": true,
		"declaration-no-important": true,
		"selector-max-id": 0,
		"selector-max-compound-selectors": 4,
		"selector-max-specificity": "0,4,2",
		"no-duplicate-selectors": true,
		"no-descending-specificity": null,
		"property-disallowed-list": [["backdrop-filter"], { message: "backdrop-filter costs a GPU pass every frame the content under it moves; see the CSS skill" }],
		"declaration-property-value-allowed-list": [{ "font-weight": ["400", "700", "inherit"] }, { message: "Chinese fonts on Android have no 500 or 600: the weight falls back to 400 and only Latin letters turn bold; use 400 or 700" }],
		"selector-pseudo-class-disallowed-list": [["focus-visible"], { message: "a focus ring makes the app read as a web page; show focus with the element's own border or background, never a ring" }],
	},
};
