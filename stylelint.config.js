export default {
	extends: ["stylelint-config-recommended"],
	plugins: ["./stylelint/keyframes-compositor-only.js"],
	rules: {
		"pi-mobile/keyframes-compositor-only": true,
		"declaration-no-important": true,
		"selector-max-id": 0,
		"selector-max-compound-selectors": 4,
		"selector-max-specificity": "0,4,2",
		"no-duplicate-selectors": true,
		"no-descending-specificity": null,
	},
};
