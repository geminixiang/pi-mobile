import { existsSync, readFileSync } from "node:fs";
import { parseSync } from "rolldown/utils";

const MAP = "docs/feature-map.md";
const SCREEN_HOSTS = ["src/app/App.tsx", "src/workbench/Workbench.tsx", "src/app/BotPanel.tsx"];
const NAMED = /`([A-Z]\w*)` \(`(src\/[^`]+)`\)/g;
const ICON = /(Icon|Mark)$/;

type Node = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function rendered(file: string): Set<string> {
	const names = new Set<string>();
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!isNode(node)) return;
		if (node.type === "JSXOpeningElement" && isNode(node.name) && node.name.type === "JSXIdentifier" && typeof node.name.name === "string") names.add(node.name.name);
		Object.values(node).forEach(visit);
	};
	visit(parseSync(file, readFileSync(file, "utf8")).program);
	return names;
}

const map = readFileSync(MAP, "utf8");
const named = [...map.matchAll(NAMED)].map(([, component, file]) => ({ component, file }));
const missing = named.filter(({ component, file }) => !existsSync(file) || !new RegExp(`(function|const|class) ${component}\\b`).test(readFileSync(file, "utf8")));
const mapped = new Set(named.map(({ component }) => component));
const unmapped = SCREEN_HOSTS.flatMap((file) => [...rendered(file)].filter((name) => /^[A-Z]/.test(name) && !ICON.test(name) && !mapped.has(name)).map((name) => ({ name, file })));

const SETTINGS = "src/app/Settings.tsx";
const PAGE_TITLE = /^\t{2,3}(?:\w+: \{ )?title: "([^"]+)"/gm;
const pages = [...readFileSync(SETTINGS, "utf8").matchAll(PAGE_TITLE)].map(([, title]) => title);
const unlistedPages = pages.filter((title) => !map.includes(`設定 › ${title}`));

const problems = [
	...(pages.length === 0 ? [`${SETTINGS}: no settings page titles found; update PAGE_TITLE in test/feature-map.ts to how the pages are declared now`] : []),
	...unlistedPages.map((title) => `${SETTINGS} has the settings page ${title}, which ${MAP} does not list: add a row 設定 › ${title} with its component`),
	...missing.map(({ component, file }) => `${MAP} names ${component} in ${file}, which does not define it: update the map to the component that renders that part now`),
	...unmapped.map(({ name, file }) => `${file} renders ${name}, which ${MAP} does not list: add it to the map with the name the user calls it by (or to 共用的骨架), as \`${name}\` (\`its file\`)`),
];
if (problems.length > 0) {
	for (const problem of problems) console.error(problem);
	process.exit(1);
}
console.log(`feature map: ${mapped.size} components named, each exists, and every screen ${SCREEN_HOSTS.map((file) => file.split("/").at(-1)).join(", ")} render is on the map`);
