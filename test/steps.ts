import assert from "node:assert/strict";
import { preview, stepsLabel } from "../src/app/steps.ts";

const page = ["Tabs (at most 8): 1 GitHub (this one)", "Stopped at step 5 (scroll): Failed to scroll; the steps before it ran. The page now:", "Current Page: [GitHub](https://github.com)", ...Array.from({ length: 400 }, (_, n) => `[${n}]<a>link ${n}</a>`)];
assert.deepEqual(preview("use_browser", page), { shown: ["第 5 步 scroll 失敗"], hidden: 0 });
assert.deepEqual(preview("use_browser", ["Stopped at step 5 (scroll): ❌ Failed to scroll: Error: DOM tree not indexed yet. Can not perform actions on elements.; the steps before it ran. The page now:"]).shown, ["第 5 步 scroll 失敗：DOM tree not indexed yet. Can not perform actions on elements."]);
assert.deepEqual(preview("use_phone_screen", ["Stopped at step 2 (tap): no element 7 on this screen; the steps before it ran. The screen now:"]).shown, ["第 2 步 tap 失敗：no element 7 on this screen"]);
assert.deepEqual(preview("use_browser", ["Stopped at the page: it closed; the steps before it ran."]).shown, ["the page: it closed"]);
assert.deepEqual(preview("read_page", page.filter((line) => !line.startsWith("Stopped"))), { shown: [], hidden: 0 });
assert.deepEqual(preview("web_fetch", page).shown.length, 10);
assert.deepEqual(preview("tool_search", ["Loaded 5 tools. They are available from your next call:", "- use_browser: Use this Bot's own browser"]), { shown: [], hidden: 0 });
assert.equal(stepsLabel([{ action: "wait", ms: 3000 }, { action: "open", url: "https://github.com/geminixiang/pi-mobile" }, { action: "wait_for", text: "README" }, { action: "scroll" }, { action: "wait" }, { action: "scroll" }, { action: "scroll" }]), "open github.com/geminixiang/pi-mobile · scroll ×3");
assert.equal(stepsLabel([{ action: "open", app: "LINE" }, { action: "tap", x: 1, y: 2 }]), "open LINE · tap");
assert.equal(stepsLabel("steps"), undefined);
console.log("steps: a screen tool's box shows only why it stopped, in Chinese, a tool search shows none of the tools it loaded, and a label names the steps instead of their JSON");
