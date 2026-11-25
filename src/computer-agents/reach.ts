import type { CommandClient } from "../computer/commands.ts";
import type { PairedHost } from "../computer/pairing.ts";
import type { Workplace } from "../agent/workplaces.ts";
import { type Place, placeOf } from "./workers.ts";

const ON = "/";
const LOCAL_ID = ":";

type AgentId = { form: "on_computer"; computer: string; local: string } | { form: "legacy_on_own_computer"; local: string };

export type Reachable = { id: string; host: PairedHost; computer: Pick<CommandClient, "run">; place: Place };

export type Reached = ({ ok: true } & Reachable) | { ok: false; reason: "not_an_id" | "not_paired" | "phone"; problem: string };

export const computerName = (host: Pick<PairedHost, "address">): string => host.address.split(".")[0] ?? host.address;

export const ownHost = (place: Workplace | undefined): PairedHost | undefined => (place?.kind === "computer" ? place.host : undefined);

export const agentIdOn = (host: Pick<PairedHost, "address">, local: string): string => `${computerName(host)}${ON}${local}`;

export function parseAgentId(id: string): AgentId {
	const at = id.indexOf(ON);
	const computer = id.slice(0, Math.max(at, 0));
	if (computer === "" || computer.includes(LOCAL_ID)) return { form: "legacy_on_own_computer", local: id };
	return { form: "on_computer", computer, local: id.slice(at + ON.length) };
}

export function reachAgent(id: string, hosts: readonly PairedHost[], own: PairedHost | undefined, commandsOf: (host: PairedHost) => Pick<CommandClient, "run">): Reached {
	const parsed = parseAgentId(id);
	const place = placeOf(parsed.local);
	if (!place) return { ok: false, reason: "not_an_id", problem: `${id} is not an agent id: take one from list_agents.` };
	const host = parsed.form === "legacy_on_own_computer" ? own : hosts.find((candidate) => computerName(candidate) === parsed.computer);
	if (host) return { ok: true, id: agentIdOn(host, parsed.local), host, computer: commandsOf(host), place };
	if (parsed.form === "legacy_on_own_computer") return { ok: false, reason: "phone", problem: `${id} names no computer and this bot works on the phone: take the id from list_agents.` };
	return { ok: false, reason: "not_paired", problem: `No paired computer is called ${parsed.computer}: the paired ones are ${hosts.map(computerName).join(", ") || "none"}.` };
}
