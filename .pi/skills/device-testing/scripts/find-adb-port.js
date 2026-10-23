import net from "node:net";

const host = process.argv[2];
if (!host) throw new Error("usage: node find-adb-port.js <phone ip>");
const open = [];
const probe = (port) =>
	new Promise((resolve) => {
		const socket = net.connect({ host, port });
		socket.setTimeout(1500);
		socket.on("connect", () => {
			open.push(port);
			socket.destroy();
			resolve();
		});
		socket.on("timeout", () => {
			socket.destroy();
			resolve();
		});
		socket.on("error", () => resolve());
	});
for (let port = 30000; port <= 65000; port += 500) await Promise.all(Array.from({ length: 500 }, (_, i) => probe(port + i)));
console.log(open.join(" ") || "no open port");
