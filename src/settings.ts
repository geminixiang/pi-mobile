import { type Static, Type } from "typebox";
import { DEFAULT_MODEL_ID } from "./agent/models.ts";
import { decode } from "./parse.ts";
import type { Platform } from "./agent/platform.ts";
import { log } from "./log.ts";
import { type ProviderConfig, parseProviders } from "./agent/providers.ts";
import { messageOf } from "./promise.ts";
import { type Host, parseHosts } from "./agent/sandbox/host.ts";
import { type CalendarAccess, parseCalendarAccess } from "./agent/calendar-access.ts";

const PLAIN_KEY = "pi-mobile.settings";
const DEFAULT_COMPACT_AT_TOKENS = 256_000;
const providerKey = (id: string) => `provider.${id}.apiKey`;
const providerOAuthKey = (id: string) => `provider.${id}.oauth`;
const SECRET_GITHUB_TOKEN = "github.token";
const SECRET_GCLOUD = "gcloud.credential";
const SECRET_CLOUDFLARE = "cloudflare.credential";
const SECRET_AZURE = "azure.credential";
const hostKey = (id: string) => `host.${id}.key`;

export const SEARCH_ENGINES = {
	duckduckgo: { name: "DuckDuckGo", home: "https://duckduckgo.com/", search: "https://duckduckgo.com/?q=" },
	google: { name: "Google", home: "https://www.google.com/", search: "https://www.google.com/search?q=" },
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;

export interface Settings {
	providers: ProviderConfig[];
	providerKeys: Record<string, string>;
	providerOAuth: Record<string, string>;
	githubToken: string;
	gcloudCredential: string;
	gcloudProject: string;
	cloudflareCredential: string;
	azureCredential: string;
	defaultProvider: string;
	defaultModelId: string;
	defaultThinking: string;
	calendarAccess: CalendarAccess;
	hosts: Host[];
	hostKeys: Record<string, string>;
	computer: string;
	compactAt: number;
	searchEngine: SearchEngine;
}

const PlainSettings = Type.Object({
	providers: Type.Optional(Type.String()),
	defaultProvider: Type.Optional(Type.String()),
	gcloudProject: Type.Optional(Type.String()),
	defaultModelId: Type.Optional(Type.String()),
	defaultThinking: Type.Optional(Type.String()),
	calendarAccess: Type.Optional(Type.String()),
	hosts: Type.Optional(Type.String()),
	computer: Type.Optional(Type.String()),
	compactAt: Type.Optional(Type.Number()),
	searchEngine: Type.Optional(Type.String()),
});
type PlainSettings = Static<typeof PlainSettings>;

export type SettingsStorage = Pick<Platform, "plain" | "secrets">;

export type RotatingSecret = { kind: "provider"; id: string } | { kind: "cloudflare" } | { kind: "azure" };

const rotatingKey = (secret: RotatingSecret) => (secret.kind === "provider" ? providerOAuthKey(secret.id) : secret.kind === "cloudflare" ? SECRET_CLOUDFLARE : SECRET_AZURE);

export class SettingsStore {
	readonly #storage: SettingsStorage;
	readonly #asLoaded = new Map<string, string>();
	readonly #rotations = new Map<string, { latest: string; replaced: ReadonlySet<string> }>();
	readonly #unreadable = new Set<string>();

	constructor(storage: SettingsStorage) {
		this.#storage = storage;
	}

	async load(): Promise<Settings> {
		const plain = this.#plain();
		const providers = parseProviders(plain.providers);
		const hosts = parseHosts(plain.hosts);
		const read = (key: string) => this.#read(key);
		const [hostKeys, keys, oauth, githubToken, gcloudCredential, cloudflareCredential, azureCredential] = await Promise.all([
			Promise.all(hosts.map(async (host) => [host.id, await read(hostKey(host.id))] as const)),
			Promise.all(providers.map(async (provider) => [provider.id, await read(providerKey(provider.id))] as const)),
			Promise.all(providers.map(async (provider) => [provider.id, await read(providerOAuthKey(provider.id))] as const)),
			...[SECRET_GITHUB_TOKEN, SECRET_GCLOUD, SECRET_CLOUDFLARE, SECRET_AZURE].map(read),
		]);
		return {
			providers,
			providerKeys: Object.fromEntries(keys),
			providerOAuth: Object.fromEntries(oauth.filter(([, json]) => json)),
			defaultProvider: plain.defaultProvider || providers[0]?.id || "",
			githubToken,
			gcloudCredential,
			gcloudProject: plain.gcloudProject ?? "",
			cloudflareCredential,
			azureCredential,
			defaultModelId: plain.defaultModelId ?? DEFAULT_MODEL_ID,
			defaultThinking: plain.defaultThinking ?? "low",
			calendarAccess: parseCalendarAccess(plain.calendarAccess),
			hosts,
			hostKeys: Object.fromEntries(hostKeys.filter(([, key]) => key)),
			computer: plain.computer ?? "",
			compactAt: plain.compactAt ?? DEFAULT_COMPACT_AT_TOKENS,
			searchEngine: plain.searchEngine === "google" ? "google" : "duckduckgo",
		};
	}

	withRotated(settings: Settings): Settings {
		return {
			...settings,
			providerOAuth: Object.fromEntries(Object.entries(settings.providerOAuth).map(([id, json]) => [id, this.#keepRotated(providerOAuthKey(id), json)])),
			cloudflareCredential: this.#keepRotated(SECRET_CLOUDFLARE, settings.cloudflareCredential),
			azureCredential: this.#keepRotated(SECRET_AZURE, settings.azureCredential),
		};
	}

	async save(edited: Settings): Promise<Settings> {
		const settings = this.withRotated(edited);
		const previous = this.#plain();
		const before = parseProviders(previous.providers);
		const { providers, hosts } = settings;
		const plain: PlainSettings = {
			providers: JSON.stringify(providers),
			defaultProvider: settings.defaultProvider,
			gcloudProject: settings.gcloudProject,
			defaultModelId: settings.defaultModelId,
			defaultThinking: settings.defaultThinking,
			calendarAccess: JSON.stringify(settings.calendarAccess),
			hosts: JSON.stringify(hosts),
			computer: settings.computer,
			compactAt: settings.compactAt,
			searchEngine: settings.searchEngine,
		};
		this.#storage.plain.set(PLAIN_KEY, JSON.stringify(plain));
		for (const provider of providers) {
			await this.#save(providerKey(provider.id), settings.providerKeys[provider.id] ?? "");
			await this.#save(providerOAuthKey(provider.id), settings.providerOAuth[provider.id] ?? "");
		}
		for (const provider of before.filter((old) => !providers.some((kept) => kept.id === old.id))) {
			await this.#storage.secrets.remove(providerKey(provider.id));
			await this.#storage.secrets.remove(providerOAuthKey(provider.id));
		}
		for (const host of hosts) await this.#save(hostKey(host.id), settings.hostKeys[host.id] ?? "");
		for (const host of parseHosts(previous.hosts).filter((old) => !hosts.some((kept) => kept.id === old.id))) await this.#storage.secrets.remove(hostKey(host.id));
		await this.#save(SECRET_GITHUB_TOKEN, settings.githubToken);
		await this.#save(SECRET_GCLOUD, settings.gcloudCredential);
		await this.#save(SECRET_CLOUDFLARE, settings.cloudflareCredential);
		await this.#save(SECRET_AZURE, settings.azureCredential);
		return settings;
	}

	async rotate(secret: RotatingSecret, json: string): Promise<void> {
		const key = rotatingKey(secret);
		await this.#storage.secrets.set(key, json);
		const before = this.#rotations.get(key);
		const replaced = [...(before?.replaced ?? []), before?.latest ?? this.#asLoaded.get(key) ?? ""].filter((value) => value !== "");
		this.#rotations.set(key, { latest: json, replaced: new Set(replaced) });
	}

	#plain(): PlainSettings {
		return decode(PlainSettings, this.#storage.plain.get(PLAIN_KEY)) ?? {};
	}

	async #read(key: string): Promise<string> {
		this.#rotations.delete(key);
		const value = await this.#storage.secrets.get(key).then(
			(stored) => {
				this.#unreadable.delete(key);
				return stored ?? "";
			},
			(error: unknown) => {
				this.#unreadable.add(key);
				log.warn("settings.secret_unreadable", { key, error: messageOf(error) });
				return "";
			},
		);
		this.#asLoaded.set(key, value);
		return value;
	}

	#keepRotated(key: string, value: string): string {
		const rotation = this.#rotations.get(key);
		return rotation?.replaced.has(value) ? rotation.latest : value;
	}

	async #save(key: string, value: string): Promise<void> {
		const wouldEraseUnreadSecret = !value && this.#unreadable.has(key);
		if (wouldEraseUnreadSecret || value === this.#asLoaded.get(key)) return;
		this.#unreadable.delete(key);
		if (value) await this.#storage.secrets.set(key, value);
		else await this.#storage.secrets.remove(key);
		this.#asLoaded.set(key, value);
		if (this.#rotations.get(key)?.latest !== value) this.#rotations.delete(key);
	}
}

export function changedKeys<T extends object>(before: T, after: T): (keyof T)[] {
	const changed: (keyof T)[] = [];
	for (const key in before) {
		const a = before[key];
		const b = after[key];
		if (typeof a === "object" || typeof b === "object" ? JSON.stringify(a) !== JSON.stringify(b) : a !== b) changed.push(key);
	}
	return changed;
}

export function providerReady(config: ProviderConfig, apiKey: string, signIn: string): boolean {
	return config.kind === "custom" ? Boolean(config.baseUrl) : Boolean(apiKey || signIn);
}

export function usableProviders(settings: Pick<Settings, "providers" | "providerKeys" | "providerOAuth">): ProviderConfig[] {
	return settings.providers.filter((provider) => providerReady(provider, settings.providerKeys[provider.id] ?? "", settings.providerOAuth[provider.id] ?? ""));
}

export function signedInWithChatGPT(settings: Settings, credential: string): Settings {
	const openai: ProviderConfig = { kind: "builtin", id: "openai" };
	return { ...settings, providers: [openai], providerOAuth: { ...settings.providerOAuth, openai: credential }, defaultProvider: openai.id };
}

export function isConfigured(settings: Settings): boolean {
	return usableProviders(settings).length > 0;
}
