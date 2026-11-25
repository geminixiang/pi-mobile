import stylelint from "stylelint";

const name = "pi-mobile/keyframes-compositor-only";
const ALLOWED = new Set(["opacity", "transform", "translate", "scale", "rotate", "background-color", "color", "visibility"]);
const messages = stylelint.utils.ruleMessages(name, {
	rejected: (property) => `"${property}" in @keyframes: animate opacity or transform instead; a shadow or a tint goes on a ::before/::after whose opacity is animated (CSS skill §4)`,
});

function inKeyframes(node) {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) return true;
	}
	return false;
}

const rule = (enabled) => (root, result) => {
	if (!enabled) return;
	root.walkDecls((decl) => {
		if (!inKeyframes(decl)) return;
		const property = decl.prop.toLowerCase();
		if (property.startsWith("--") || ALLOWED.has(property)) return;
		stylelint.utils.report({ ruleName: name, result, node: decl, message: messages.rejected(property) });
	});
};
rule.ruleName = name;
rule.messages = messages;

export default stylelint.createPlugin(name, rule);
