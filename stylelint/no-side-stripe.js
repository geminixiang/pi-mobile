import stylelint from "stylelint";

const name = "pi-mobile/no-side-stripe";
const SIDES = ["border-left", "border-right", "border-inline"];
const messages = stylelint.utils.ruleMessages(name, {
	rejected: (property) =>
		`"${property}" draws a line along one side of a box, which this app never shows (DESIGN.md § Do's and Don'ts): mark a selected or special row with its background or a ✓, set side-by-side cells apart with gap: 1px over a var(--line) background`,
});

const sideShadow = (value) =>
	value
		.split(/,(?![^(]*\))/)
		.map((shadow) => shadow.trim())
		.some((shadow) => {
			if (!shadow.startsWith("inset") && !shadow.endsWith("inset")) return false;
			const [x = "0", y = "0"] = shadow.replace("inset", "").trim().split(/\s+/);
			return Number.parseFloat(x) !== 0 && Number.parseFloat(y) === 0;
		});

const rule = (enabled) => (root, result) => {
	if (!enabled) return;
	root.walkDecls((decl) => {
		const property = decl.prop.toLowerCase();
		const stripe = SIDES.some((side) => property.startsWith(side) && !property.endsWith("-radius")) || (property === "box-shadow" && sideShadow(decl.value));
		if (stripe) stylelint.utils.report({ ruleName: name, result, node: decl, message: messages.rejected(property) });
	});
};
rule.ruleName = name;
rule.messages = messages;

export default stylelint.createPlugin(name, rule);
