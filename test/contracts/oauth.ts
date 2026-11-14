import assert from "node:assert/strict";
import { jwtPayload } from "../../src/agent/oauth.ts";
import type { Check } from "./setup.ts";

const base64Url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

export const checks: Check[] = [
	[
		"a sign-in token's claims keep a name written in Chinese",
		async () => {
			const token = `${base64Url('{"alg":"none"}')}.${base64Url('{"name":"王小明"}')}.`;
			assert.deepEqual(jwtPayload(token), { name: "王小明" });
		},
	],
];
