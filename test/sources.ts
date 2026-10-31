import assert from "node:assert/strict";
import { isSource } from "../src/app/sources.ts";

assert.equal(isSource("https://www.pixnet.net/blog/1", "pixnet"), true);
assert.equal(isSource("https://twincn.com/item.aspx?no=1", "twincn"), true);
assert.equal(isSource("https://go.dshtui.com/c/abc", "go.dshtui.com"), true);
assert.equal(isSource("https://www.cna.com.tw/news/1", "CNA"), true);
assert.equal(isSource("https://www.pixnet.net/blog/1", "官方文件"), false);
assert.equal(isSource("https://www.pixnet.net/blog/1", "net"), false);
assert.equal(isSource("https://www.pixnet.net/blog/1", ""), false);
assert.equal(isSource("notes/pixnet.md", "pixnet"), false);
assert.equal(isSource("mailto:pixnet@example.com", "pixnet"), false);
