import { Bash, InMemoryFs } from "just-bash/browser";
import { createGit } from "just-git";
import { gitCommand } from "../../src/agent/files/git-command.ts";
import { catFile } from "../../src/agent/files/git-inspection.ts";

let checks = 0;
function assert(condition: unknown, label: string): asserts condition {
	if (!condition) throw new Error(label);
	checks++;
}

const fs = new InMemoryFs();
await fs.mkdir("/repo", { recursive: true });
const requests: string[] = [];
const bash = new Bash({ fs, cwd: "/repo", customCommands: [gitCommand(async (input) => {
	requests.push(String(input));
	throw new Error("network disabled in inspection tests");
})] });
const git = createGit();
const context = { fs, cwd: "/repo", env: new Map<string, string>(), stdin: "" };
async function run(command: string) {
	return bash.exec(command);
}
async function ok(command: string) {
	const result = await run(command);
	assert(result.exitCode === 0, `${command}: ${result.stderr}`);
	return result.stdout;
}
async function rejected(command: string) {
	const result = await run(command);
	assert(result.exitCode !== 0 && result.stderr.length > 0 && result.stdout === "", `${command}: must fail clearly without stdout`);
}

await ok("git init");
const repo = await git.findRepo({ fs, cwd: "/repo" });
assert(repo, "fixture repository exists");
const text = new TextEncoder().encode("中文\n");
const blob = await repo.objectStore.write("blob", text);
assert(await ok(`git cat-file -t ${blob}`) === "blob\n", "blob type");
assert(await ok(`git cat-file -s ${blob}`) === `${text.byteLength}\n`, "byte size rather than UTF-16 length");
assert(await ok(`git cat-file -p ${blob}`) === "中文\n", "UTF-8 pretty content");
const bom = await repo.objectStore.write("blob", new Uint8Array([239, 187, 191, 65]));
assert(await ok(`git cat-file -p ${bom}`) === "\ufeffA", "preserve BOM bytes");
const binary = await repo.objectStore.write("blob", new Uint8Array([65, 0, 255]));
await rejected(`git cat-file -p ${binary}`);
assert(await ok(`git cat-file -s ${binary}`) === "3\n", "binary size is still available");
const invalid = await repo.objectStore.write("blob", new Uint8Array([255]));
await rejected(`git cat-file -p ${invalid}`);
const large = await repo.objectStore.write("blob", new Uint8Array(1024 * 1024 + 1).fill(65));
await rejected(`git cat-file -p ${large}`);
const treePrefix = new TextEncoder().encode("100644 file.txt\0");
const treeBytes = new Uint8Array(treePrefix.length + 20);
treeBytes.set(treePrefix);
for (let i = 0; i < 20; i++) treeBytes[treePrefix.length + i] = Number.parseInt(blob.slice(i * 2, i * 2 + 2), 16);
const tree = await repo.objectStore.write("tree", treeBytes);
assert(await ok(`git cat-file -t ${tree}`) === "tree\n", "tree type");
assert(await ok(`git cat-file -s ${tree}`) === `${treeBytes.byteLength}\n`, "tree raw size");
assert(await ok(`git cat-file -p ${tree}`) === `100644 blob ${blob}\tfile.txt\n`, "tree pretty output");
const commitText = `tree ${tree}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nfixture\n`;
const commit = await repo.objectStore.write("commit", new TextEncoder().encode(commitText));
assert(await ok(`git cat-file -t ${commit}`) === "commit\n", "commit type");
assert(await ok(`git cat-file -p ${commit}`) === commitText, "commit pretty content");
const tagText = `object ${commit}\ntype commit\ntag fixture\ntagger Test <test@example.invalid> 0 +0000\n\nfixture tag\n`;
const tag = await repo.objectStore.write("tag", new TextEncoder().encode(tagText));
assert(await ok(`git cat-file -t ${tag}`) === "tag\n", "annotated tag type remains tag");
assert(await ok(`git cat-file -p ${tag}`) === tagText, "tag content");
for (const args of ["", "--batch", "-t", "-e HEAD", "-p -t HEAD", "-t no-such-object", `-t ${"0".repeat(40)}`]) {
	await rejected(`git cat-file ${args}`);
}
await rejected("git -C /repo cat-file -t HEAD");
await fs.writeFile("/repo/.git/HEAD", `${commit}\n`);
assert(await ok("git cat-file -t HEAD") === "commit\n", "HEAD revision");
assert(await ok("git cat-file -p HEAD^{tree}") === `100644 blob ${blob}\tfile.txt\n`, "tree peel revision");
assert(await ok(`git cat-file -s ${commit}`) === `${new TextEncoder().encode(commitText).byteLength}\n`, "commit byte size");
assert(await ok(`git cat-file -s ${tag}`) === `${new TextEncoder().encode(tagText).byteLength}\n`, "tag byte size");
assert(await ok(`git cat-file -t ${blob.slice(0, 12)}`) === "blob\n", "abbreviated object ID");
const spacedPrefix = new TextEncoder().encode("100644 two words\0");
const spacedBytes = new Uint8Array(spacedPrefix.length + 20);
spacedBytes.set(spacedPrefix);
spacedBytes.set(treeBytes.subarray(treePrefix.length), spacedPrefix.length);
const spacedTree = await repo.objectStore.write("tree", spacedBytes);
assert(await ok(`git cat-file -p ${spacedTree}`) === `100644 blob ${blob}\ttwo words\n`, "space-containing tree name remains unquoted");
const broken = Object.assign(createGit(), { findRepo: async () => { throw new Error("object store unavailable"); } });
assert((await catFile(broken, ["-p", blob], context)).stderr.includes("object store unavailable"), "object I/O failure is surfaced");
const outside = { ...context, cwd: "/" };
assert((await catFile(git, ["-t", blob], outside)).exitCode !== 0, "not a repository");
function exact(actual: { stdout: string; stderr: string; exitCode: number }, expected: { stdout: string; stderr: string; exitCode: number }, label: string) {
	assert(actual.stdout === expected.stdout && actual.stderr === expected.stderr && actual.exitCode === expected.exitCode, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
exact(await run(`git cat-file -p ${spacedTree}`), { stdout: `100644 blob ${blob}\ttwo words\n`, stderr: "", exitCode: 0 }, "oracle tree space remains unquoted");
for (const [name, quoted] of [["中文", '"\\344\\270\\255\\346\\226\\207"'], ["two\twords", '"two\\twords"']]) {
	const prefix = new TextEncoder().encode(`100644 ${name}\0`);
	const content = new Uint8Array(prefix.length + 20);
	content.set(prefix);
	content.set(treeBytes.subarray(treePrefix.length), prefix.length);
	const namedTree = await repo.objectStore.write("tree", content);
	exact(await run(`git cat-file -p ${namedTree}`), { stdout: `100644 blob ${blob}\t${quoted}\n`, stderr: "", exitCode: 0 }, `oracle tree quoted ${JSON.stringify(name)}`);
}
assert(requests.length === 0, "local inspection never requests identity or network");
console.log(`git inspection: ${checks} checks pass`);
