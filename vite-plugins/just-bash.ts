import type { Plugin } from "vite";

export const JUST_BASH_VERSION = "3.6.0";
const BUNDLE = /node_modules\/just-bash\/dist\/bundle\/browser\.js$/;

type Patch = { name: string; find: string; replace: string };

const PATCHES: Patch[] = [
	{
		name: "jq unique sorts",
		find: `case"unique":if(Array.isArray(e)){let i=new Set,o=[];for(let l of e){let a=JSON.stringify(l);i.has(a)||(i.add(a),o.push(l))}return[o]}`,
		replace: `case"unique":if(Array.isArray(e)){let i=new Set,o=[];for(let l of e){let a=JSON.stringify(l);i.has(a)||(i.add(a),o.push(l))}return[o.sort(Ga)]}`,
	},
	{
		name: "jq @csv quotes every string",
		find: `let i=String(s);return i.includes(",")||i.includes('"')||i.includes(\`
\`)||i.includes("\\r")?\`"\${i.replace(/"/g,'""')}"\`:i}).join(",")`,
		replace: `let i=String(s);return\`"\${i.replace(/"/g,'""')}"\`}).join(",")`,
	},
	{
		name: "grep BRE \\+ and \\? are quantifiers (GNU)",
		find: `if(o==="}"){t+="\\\\}",n+=2,r=!1;continue}t+=i+o,n+=2,r=!1;continue}`,
		replace: `if(o==="}"){t+="\\\\}",n+=2,r=!1;continue}if((o==="+"||o==="?")&&!r){t+=o,n+=2;continue}t+=i+o,n+=2,r=!1;continue}`,
	},
	{
		name: "awk: referencing an array element creates it",
		find: `return Fa(e,t.array,n)}async function NE(e,t){`,
		replace: `return t.array!=="ARGV"&&t.array!=="ENVIRON"&&!e0(e,t.array,n)&&_u(e,t.array,n,""),Fa(e,t.array,n)}async function NE(e,t){`,
	},
	{
		name: "awk length(array) counts its elements",
		find: `async function rE(e,t,n){return e.length===0?t.line.length:`,
		replace: `async function rE(e,t,n){if(e.length>0&&e[0].type==="variable"){let __jbArray=t.arrays[yo(t,e[0].name)];if(__jbArray)return Object.keys(__jbArray).length}return e.length===0?t.line.length:`,
	},
	{
		name: "awk -v sets OFS, ORS and SUBSEP",
		find: `p.vars=Object.assign(Object.create(null),i),`,
		replace: `p.vars=Object.assign(Object.create(null),i);for(let __jbName of["OFS","ORS","SUBSEP"])__jbName in i&&(p[__jbName]=String(i[__jbName]),delete p.vars[__jbName]);`,
	},
	{
		name: "sort: blanks before the first field belong to it",
		find: `function Hu(e,t,n){let r=n!==null?n:/\\s+/,s=e.split(r),`,
		replace: `function Hu(e,t,n){let r=n!==null?n:/\\s+/,s=(n!==null?e:e.trimStart()).split(r),`,
	},
	{
		name: "uniq -c pads counts to seven columns",
		find: `r?g+=\`\${String(y).padStart(4)} \${b}`,
		replace: `r?g+=\`\${String(y).padStart(7)} \${b}`,
	},
	{
		name: "od takes -tFORMAT attached",
		find: `else if(g==="-t"&&e[m+1]){let b=e[++m];`,
		replace: `else if(g.startsWith("-t")&&(g.length>2||e[m+1])){let b=g.length>2?g.slice(2):e[++m];`,
	},
	{
		name: "head -n -N prints all but the last N lines",
		find: `function S1(e,t,n){if(n!==null)return e.slice(0,n);if(t===0)return"";`,
		replace: `function S1(e,t,n){if(n!==null)return e.slice(0,n);if(t<0){let l=e.split("\\n");e.endsWith("\\n")&&l.pop();let k=l.slice(0,Math.max(0,l.length+t));return k.length>0?k.join("\\n")+"\\n":""}if(t===0)return"";`,
	},
	{
		name: "head accepts a negative line count",
		find: `:Number.isNaN(n)||n<0?{ok:!1,error:{stdout:"",stderr:\`\${t}: invalid number of lines`,
		replace: `:Number.isNaN(n)||n<0&&t!=="head"?{ok:!1,error:{stdout:"",stderr:\`\${t}: invalid number of lines`,
	},
	{
		name: "sort -g sorts numerically",
		find: `else if(u==="-n"||u==="--numeric-sort")n.numeric=!0;`,
		replace: `else if(u==="-n"||u==="--numeric-sort"||u==="-g"||u==="--general-numeric-sort")n.numeric=!0;`,
	},
	{
		name: "sort -g in combined flags",
		find: `else if(d==="n")n.numeric=!0;`,
		replace: `else if(d==="n"||d==="g")n.numeric=!0;`,
	},
	{
		name: "xargs takes option values attached (-I{}, -n2, -d,, -P4)",
		find: `kA={name:"xargs",async execute(e,t){if(Z(e))return q(CA);`,
		replace: `kA={name:"xargs",async execute(e,t){if(Z(e))return q(CA);e=__jbSplitAttachedOptions(e,"IdnP");`,
	},
	{
		name: "paste reads stdin without operands",
		find: `if(i.length===0)return{stdout:"",stderr:\`usage: paste [-s] [-d delimiters] file ...
\`,exitCode:1};`,
		replace: `if(i.length===0)i=["-"];`,
	},
	{
		name: "awk -f progfile: option",
		find: `let r=new Pr(/\\s+/),s=" ",i=Object.create(null),o=0;for(let b=0;b<e.length;b++){let y=e[b];if(y==="-F"&&b+1<e.length)`,
		replace: `let r=new Pr(/\\s+/),s=" ",i=Object.create(null),o=0,__jbProgramFile=null;for(let b=0;b<e.length;b++){let y=e[b];if(y==="-f"&&b+1<e.length)__jbProgramFile=e[++b],o=b+1;else if(y==="-F"&&b+1<e.length)`,
	},
	{
		name: "awk -f progfile: program",
		find: `if(o>=e.length)return{stdout:"",stderr:\`awk: missing program
\`,exitCode:1};let l=e[o],a=e.slice(o+1),`,
		replace: `if(o>=e.length&&__jbProgramFile===null)return{stdout:"",stderr:\`awk: missing program
\`,exitCode:1};let l=__jbProgramFile===null?e[o]:await t.fs.readFile(t.fs.resolvePath(t.cwd,__jbProgramFile)),a=__jbProgramFile===null?e.slice(o+1):e.slice(o),`,
	},
	{
		name: "awk printf %f takes the 0, + and space flags",
		find: `let S=w.toFixed(x);if(f){let E=parseInt(f,10);u.includes("-")?S=S.padEnd(E):S=S.padStart(E)}a(S)`,
		replace: `let S=w.toFixed(x);w>=0&&u.includes("+")?S="+"+S:w>=0&&u.includes(" ")&&(S=" "+S);if(f){let E=parseInt(f,10);u.includes("-")?S=S.padEnd(E):u.includes("0")?S=/^[+\\- ]/.test(S)?S[0]+S.slice(1).padStart(E-1,"0"):S.padStart(E,"0"):S=S.padStart(E)}a(S)`,
	},
	{
		name: "sed a\\text, i\\text, c\\text one-liners",
		find: `this.peek()==="\\\\"&&this.pos+1<this.input.length&&(this.input[this.pos+1]===\`
\`||this.input[this.pos+1]===" "||this.input[this.pos+1]==="	")&&(this.advance(),`,
		replace: `this.peek()==="\\\\"&&this.pos+1<this.input.length&&(this.advance(),`,
	},
	{
		name: "yes stops at a million lines",
		find: `l=Math.min(t.limits.maxLoopIterations,Math.max(1,o));return{stdout:Uh(i,l,s,"yes")`,
		replace: `l=Math.min(t.limits.maxLoopIterations,1e6,Math.max(1,o));return{stdout:Uh(i,l,s,"yes")`,
	},
	{
		name: "$( ) in $(( )) sees the shell's functions",
		find: `case"ArithCommandSubst":{if(e.execFn){let i=await e.execFn(t.command,{signal:e.state.signal});`,
		replace: `case"ArithCommandSubst":{if(e.executeScript){let i=await __jbArithmeticSubstitution(e,t.command);`,
	},
	{
		name: "$( ) in $(( )) sees the shell's functions, as text",
		find: `case"ArithCommandSubst":return e.execFn?(await e.execFn(t.command,{signal:e.state.signal})).stdout.trim():"0";`,
		replace: `case"ArithCommandSubst":return e.executeScript?(await __jbArithmeticSubstitution(e,t.command)).stdout.trim():"0";`,
	},
	{
		name: "brace ranges up to a million items",
		find: `var Go=1e4,Td={maxResults:Go,`,
		replace: `var Go=1e6,Td={maxResults:Go,`,
	},
	{
		name: "date -d with a relative offset",
		find: `function bC(e,t){if(e.startsWith("@")){`,
		replace: `function bC(e,t){let __jbRelative=__jbRelativeDate(e,t,bC);if(__jbRelative!==void 0)return __jbRelative;if(e.startsWith("@")){`,
	},
];

const HELPERS = `
function __jbSplitAttachedOptions(args,takesValue){let out=[],k=0;for(;k<args.length;k++){let a=args[k];if(!a.startsWith("-")||a==="-"||a==="--"){break}if(a.length>2&&takesValue.includes(a[1])&&!a.startsWith("--")){out.push(a.slice(0,2),a.slice(2));continue}out.push(a);if(a.length===2&&takesValue.includes(a[1])&&k+1<args.length)out.push(args[++k])}return out.concat(args.slice(k))}
async function __jbArithmeticSubstitution(e,command){let env=new Map(e.state.env),cwd=e.state.cwd;try{let r=await e.executeScript(or(command));r.stderr&&(e.state.expansionStderr=(e.state.expansionStderr||"")+r.stderr);return{stdout:r.stdout,stderr:""}}finally{e.state.env=env,e.state.cwd=cwd}}
function __jbRelativeDate(text,tz,parse){if(text.startsWith("@"))return;let m=text.trim().match(/^(.*?)\\s*([+-]?\\s*\\d+)\\s+(sec|second|min|minute|hour|day|week|fortnight|month|year)s?(\\s+ago)?$/i);if(!m)return;let base=m[1].trim()===""?new Date:parse(m[1].trim(),tz);if(!base)return null;let n=Number(m[2].replace(/\\s/g,""))*(m[4]?-1:1),unit=m[3].toLowerCase(),d=new Date(base.getTime());if(unit.startsWith("sec"))d.setSeconds(d.getSeconds()+n);else if(unit.startsWith("min"))d.setMinutes(d.getMinutes()+n);else if(unit==="hour")d.setHours(d.getHours()+n);else if(unit==="day")d.setDate(d.getDate()+n);else if(unit==="week")d.setDate(d.getDate()+7*n);else if(unit==="fortnight")d.setDate(d.getDate()+14*n);else if(unit==="month")d.setMonth(d.getMonth()+n);else d.setFullYear(d.getFullYear()+n);return d}
`;

function occurrences(code: string, find: string): number {
	let count = 0;
	for (let at = code.indexOf(find); at !== -1; at = code.indexOf(find, at + 1)) count += 1;
	return count;
}

export function patchJustBash(code: string): string {
	const misses = PATCHES.filter((patch) => occurrences(code, patch.find) !== 1).map((patch) => `${patch.name} (${occurrences(code, patch.find)} matches)`);
	if (misses.length > 0) throw new Error(`just-bash ${JUST_BASH_VERSION} patches no longer apply: ${misses.join("; ")}. Redo them against the new bundle (docs/research/just-bash.md).`);
	return PATCHES.reduce((patched, patch) => patched.replace(patch.find, () => patch.replace), code) + HELPERS;
}

export function justBashPatches(): Plugin {
	return {
		name: "just-bash-patches",
		enforce: "pre",
		transform(code, id) {
			return BUNDLE.test(id) ? { code: patchJustBash(code), map: null } : undefined;
		},
	};
}
