import { execFileSync, spawnSync } from "node:child_process";

const SINCE = process.env.EVIDENCE_SINCE ?? "origin/main";
const TRAILER = "Evidence:";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const changesScreen = (file: string) => file.startsWith("src/") && (file.endsWith(".tsx") || file.endsWith(".css"));

if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `${SINCE}^{commit}`]).status !== 0) {
	console.log(`evidence: ${SINCE} is not in this checkout (a shallow clone), nothing to compare`);
	process.exit(0);
}
const commits = git("rev-list", `${SINCE}..HEAD`).split("\n").filter(Boolean);
const missing = commits.filter((commit) => {
	const files = git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit).split("\n");
	if (!files.some(changesScreen)) return false;
	return !git("log", "-1", "--format=%B", commit)
		.split("\n")
		.some((line) => line.startsWith(TRAILER) && line.slice(TRAILER.length).trim().length > 0);
});
if (missing.length > 0) {
	for (const commit of missing)
		console.error(
			`${git("log", "-1", "--format=%h %s", commit)}: changes a .tsx or .css under src/ but its message has no ${TRAILER} line. Add one (git commit --amend, or git rebase -i for an older commit) saying where the before and after screenshots are and, for the transcript, scrolling, streaming or an animation, the test/perf/run.ts numbers; or "${TRAILER} none, <why>" for a change nobody can see (docs/development.md § 驗證證據)`,
		);
	process.exit(1);
}
console.log(`evidence: ${commits.length} commit(s) since ${SINCE}, each that changes the screen says where its evidence is`);
