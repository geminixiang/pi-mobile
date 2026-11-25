import stylelint from "stylelint";

const name = "pi-mobile/transition-no-layout";
const LAYOUT = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "padding", "top", "right", "bottom", "left", "inset", "gap", "font-size", "line-height", "flex-basis", "border-width", "all"]);
const REPAINT = new Set(["box-shadow", "filter", "backdrop-filter"]);
const LAYOUT_PREFIX = ["margin-", "padding-", "inset-", "border-"];
const messages = stylelint.utils.ruleMessages(name, {
	rejected: (property) => `"${property}" in a transition lays out the page every frame: animate opacity or transform, or a registered --custom-property (CSS skill §4)`,
	repaint: (property) => `"${property}" in a transition repaints the element every frame: put the shadow or filter on a ::before/::after and transition its opacity (CSS skill §4)`,
});

const isLayout = (property) => LAYOUT.has(property) || LAYOUT_PREFIX.some((prefix) => property.startsWith(prefix) && !property.endsWith("-color") && !property.endsWith("-radius"));

const rule = (enabled) => (root, result) => {
	if (!enabled) return;
	root.walkDecls((decl) => {
		const property = decl.prop.toLowerCase();
		if (property !== "transition" && property !== "transition-property") return;
		for (const part of decl.value.split(",")) {
			const animated = part.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			if (isLayout(animated)) stylelint.utils.report({ ruleName: name, result, node: decl, message: messages.rejected(animated) });
			if (REPAINT.has(animated)) stylelint.utils.report({ ruleName: name, result, node: decl, message: messages.repaint(animated) });
		}
	});
};
rule.ruleName = name;
rule.messages = messages;

export default stylelint.createPlugin(name, rule);
