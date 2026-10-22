// Print the pairing link for pi mobile, as text and as a QR code. Scanning it with the phone's camera opens the app,
// which asks before saving the sandbox host. Run with the relay's env: node --env-file=~/.config/pi-sandbox/env pair.js
import { hostname } from "node:os";
import QRCode from "qrcode";

const { RELAY_HOST, RELAY_PORT, RELAY_TOKEN } = process.env;
if (!RELAY_HOST || !RELAY_TOKEN) throw new Error("Run with --env-file=~/.config/pi-sandbox/env");

const link = new URL("pimobile://pair");
link.searchParams.set("url", `ws://${RELAY_HOST}:${RELAY_PORT ?? 8787}`);
link.searchParams.set("token", RELAY_TOKEN);
link.searchParams.set("name", hostname().replace(/\.local$/, ""));

console.log("\nScan with the phone's camera to pair pi mobile with this sandbox host:\n");
console.log(await QRCode.toString(link.href, { type: "terminal", small: true }));
console.log(`Or open this link on the phone:\n${link.href}\n`);
