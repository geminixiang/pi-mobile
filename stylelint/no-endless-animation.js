import stylelint from "stylelint";

const name = "pi-mobile/no-endless-animation";
const GATES = ["[data-live]", "[data-on]"];
const messages = stylelint.utils.ruleMessages(name, {
	rejected: () => `an endless animation wakes the GPU every frame and nothing in pi blinks (DESIGN.md): show the state still (a dot, a color), or run it only while its panel is open, under [data-live] or [data-on]`,
});

const endless = (decl) => {
	const property = decl.prop.toLowerCase();
	if (property !== "animation" && property !== "animation-iteration-count") return false;
	return decl.value.toLowerCase().split(/[\s,]+/).includes("infinite");
};

const rule = (enabled) => (root, result) => {
	if (!enabled) return;
	root.walkDecls((decl) => {
		if (!endless(decl)) return;
		const selector = decl.parent?.type === "rule" ? decl.parent.selector : "";
		if (GATES.some((gate) => selector.includes(gate))) return;
		stylelint.utils.report({ ruleName: name, result, node: decl, message: messages.rejected() });
	});
};
rule.ruleName = name;
rule.messages = messages;

export default stylelint.createPlugin(name, rule);
