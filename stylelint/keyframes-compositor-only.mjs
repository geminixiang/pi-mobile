// Stylelint rule pi-mobile/keyframes-compositor-only: in @keyframes, animate only what the compositor moves without
// repainting or re-laying out the page: opacity and transform, plus a few paint-only properties used for a one-off
// highlight. A filter (blur, brightness) is redrawn every frame: a 2 px blur fading in each streamed word dropped 20 to
// 35 of about 1500 frames on the S24, against 1 or 2 with opacity alone. Layout properties (width, margin, top, ...)
// re-lay out the page every frame. See .agents/skills/css/SKILL.md.
import stylelint from "stylelint";

const name = "pi-mobile/keyframes-compositor-only";
const ALLOWED = new Set(["opacity", "transform", "translate", "scale", "rotate", "box-shadow", "background-color", "color", "visibility"]);
const messages = stylelint.utils.ruleMessages(name, {
	rejected: (property) => `"${property}" in @keyframes: animate opacity or transform instead (a one-off highlight may use box-shadow or a color)`,
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
