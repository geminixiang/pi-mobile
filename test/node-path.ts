import assert from "node:assert/strict";
import { win32 as node } from "node:path";
import { win32 } from "../src/shims/node-path.ts";

const absolute = ["C:\\Users\\me", "c:/Users/me/", "D:\\", "\\\\server\\share\\dir", "C:\\a\\..\\..\\b", "C:\\a\\.\\b\\\\c\\"];
const relative = ["docs\\a.md", "..\\up", "./x/y", "a/../b", ""];

for (const path of [...absolute, ...relative.filter(Boolean)]) {
	assert.equal(win32.isAbsolute(path), node.isAbsolute(path), `isAbsolute ${path}`);
	assert.equal(win32.normalize(path), node.normalize(path), `normalize ${path}`);
	assert.equal(win32.basename(path), node.basename(path), `basename ${path}`);
}
for (const base of absolute) {
	for (const path of [...relative, "C:\\Windows", "D:\\other"]) {
		assert.equal(win32.resolve(base, path), node.resolve(base, path), `resolve ${base} ${path}`);
		assert.equal(win32.join(base, path), node.join(base, path), `join ${base} ${path}`);
	}
}
assert.equal(win32.basename("C:\\dir\\file.txt", ".txt"), "file");

console.log("node:path shim: win32 resolves, joins, and normalizes Windows paths as Node does, so pi-env reaches a Windows computer without process.cwd");
