// CSS rules for src/app; the reasons are in .agents/skills/css/SKILL.md.
export default {
	extends: ["stylelint-config-recommended"],
	rules: {
		// Overrides that must win go outside the "app" layer (src/app/index.css), not behind !important.
		"declaration-no-important": true,
		// Classes only; an id selector can only be beaten by another id or !important.
		"selector-max-id": 0,
		// Short selectors: a long chain is high specificity and breaks when the markup moves.
		"selector-max-compound-selectors": 4,
		"selector-max-specificity": "0,4,2",
		// One rule per selector, so a property is set in one place.
		"no-duplicate-selectors": true,
		// Off: it asks for rules sorted by specificity across the file, which would scatter each component's rules;
		// layers and one rule per selector address the same overrides.
		"no-descending-specificity": null,
	},
};
