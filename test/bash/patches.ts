import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { patchJustBash } from "../../vite-plugins/just-bash.ts";

const bundle = new URL("../../node_modules/just-bash/dist/bundle/browser.js", import.meta.url);
const patchedDir = new URL("../../node_modules/.cache/just-bash/", import.meta.url);
mkdirSync(patchedDir, { recursive: true });
const patched = new URL("browser.js", patchedDir);
writeFileSync(patched, patchJustBash(readFileSync(bundle, "utf8")));
const { Bash } = await import(patched.href);
const b = new Bash({ executionLimits: { maxCommandCount: 1e7, maxLoopIterations: 1e7 } });
const checks: [string, string][] = [
	["echo '[3,1,2,1]' | jq -c unique", "[1,2,3]\n"],
	["echo '[\"a\",1,null,\"x,y\"]' | jq -r @csv", "\"a\",1,,\"x,y\"\n"],
	["printf 'AB\\n' | od -An -tx1", " 41 42 0a\n"],
	["echo a123b45 | grep -o '[0-9]\\+'", "123\n45\n"],
	["echo ab | grep -c 'a\\?b'", "1\n"],
	["echo 'a+b' | grep -o '+b'", "+b\n"],
	["printf 'alice\\ncarol\\n' > /k; printf 'alice,1\\nbob,2\\ncarol,3\\n' > /d; awk -F, 'NR==FNR{k[$1];next} $1 in k' /k /d", "alice,1\ncarol,3\n"],
	["awk 'BEGIN{a[\"x\"]; print length(a), (\"x\" in a), (\"y\" in a)}'", "1 1 0\n"],
	["awk -v OFS='-' '{print $1,$2}' <<< 'a b'", "a-b\n"],
	["printf 'a\\na\\nb\\n' | uniq -c", "      2 a\n      1 b\n"],
	["awk -v OFS='\\t' -v ORS=';' '{print $1,$2}' <<< 'a b'", "a\tb;"],
	["printf '      2 b\\n     10 a\\n      1 c\\n' | sort -k1,1nr -k2", "     10 a\n      2 b\n      1 c\n"],
	["printf '1\\n2\\n3\\n' | head -n -1", "1\n2\n"],
	["printf '1\\n2\\n3' | head -n -1", "1\n2\n"],
	["printf '1\\n2\\n' | head -n -5", ""],
	["printf '10\\n9\\n1e1\\n2.5\\n' | sort -g", "2.5\n9\n10\n1e1\n"],
	["printf 'b 10\\na 9\\n' | sort -k2 -rg", "b 10\na 9\n"],
	["printf 'a\\nb\\n' | xargs -I{} echo x-{}-y", "x-a-y\nx-b-y\n"],
	["echo 'a b c d e' | xargs -n2 echo", "a b\nc d\ne\n"],
	["echo 'a b,c' | xargs -d, -n1 echo", "a b\nc\n"],
	["printf '1\\n2\\n3\\n' | paste -sd+", "1+2+3\n"],
	["echo 'BEGIN{print 7}' > /p.awk; awk -f /p.awk", "7\n"],
	["printf 'NR>1{print $1}\\n' > /q.awk; printf 'h\\nx 1\\ny 2\\n' | awk -f /q.awk", "x\ny\n"],
	["awk 'BEGIN { printf \"%05.1f|%+.2f|% .1f|%-6.1f|\\n\", 3.14159, 2, 1.5, -2 }'", "003.1|+2.00| 1.5|-2.0  |\n"],
	["awk 'BEGIN { printf \"%06.2f\\n\", -1.5 }'", "-01.50\n"],
	["printf '1\\n2\\n' | sed '1a\\added'", "1\nadded\n2\n"],
	["printf '1\\n2\\n' | sed '2i\\ins'", "1\nins\n2\n"],
	["printf '1\\n2\\n' | sed '1a\\\nmore'", "1\nmore\n2\n"],
	["yes | head -n 3", "y\ny\ny\n"],
	["f() { echo 2; }; echo $(( $(f) + 1 ))", "3\n"],
	["fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }; fact 6", "720\n"],
	["x=1; g() { x=5; echo 4; }; echo $(( $(g) )) $x", "4 1\n"],
	["printf '%s\\n' {1..20000} | tail -1", "20000\n"],
	["TZ=UTC date -d '2024-02-28 +1 day' +%F", "2024-02-29\n"],
	["TZ=UTC date -d '2024-03-31 -1 month' +%F", "2024-03-02\n"],
	["TZ=UTC date -d '2026-01-10 3 days ago' +%F", "2026-01-07\n"],
	["TZ=UTC date -d '2026-01-10 +2 weeks' +%F", "2026-01-24\n"],
	["TZ=UTC date -d @0 +%F", "1970-01-01\n"],
];
const failures: string[] = [];
for (const [script, expected] of checks) {
	const result = await b.exec(script);
	if (result.stdout !== expected) failures.push(`${script}\n  got ${JSON.stringify(result.stdout)} ${result.stderr.trim()}\n  want ${JSON.stringify(expected)}`);
}
if (failures.length > 0) {
	console.error(`just-bash patches: ${failures.length} of ${checks.length} checks failed\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`just-bash patches: ${checks.length} checks pass`);
