// Azure credentials for az in the sandbox. Sign-in is Microsoft's device code flow with the Azure CLI's public client:
// the app shows a code (and copies it), the user enters it at microsoft.com/devicelogin, the app polls. The refresh
// token stays on the phone; the relay asks for access tokens per resource (ARM, Graph, Key Vault) when the proxy needs
// one. In the sandbox, az is signed in as a managed identity whose endpoint is the relay and hands out placeholders.
import { type Static, Type } from "typebox";
import { type AccessToken, type DeviceSignIn, getJson, jwtPayload, pollDeviceFlow, postForm, startDeviceFlow, tokensFrom } from "./oauth.ts";
import { parse, parseJson } from "./parse.ts";

const LOGIN = "https://login.microsoftonline.com";
/** The Azure CLI's public client. */
const CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const ARM_SCOPE = "https://management.core.windows.net//.default";

const AzureCredential = Type.Object({
	type: Type.Literal("azure"),
	refresh_token: Type.String(),
	tenant_id: Type.String(),
	username: Type.Optional(Type.String()),
	subscription_id: Type.Optional(Type.String()),
	subscription_name: Type.Optional(Type.String()),
});
export type AzureCredential = Static<typeof AzureCredential>;

const SignInClaims = Type.Object({
	tid: Type.Optional(Type.String()),
	preferred_username: Type.Optional(Type.String()),
	upn: Type.Optional(Type.String()),
});
const Subscriptions = Type.Object({
	value: Type.Array(Type.Object({ subscriptionId: Type.String(), displayName: Type.String(), tenantId: Type.String() })),
});

export function parseAzure(json: string): AzureCredential {
	return parse(AzureCredential, parseJson(json, "Azure 憑證"), "Azure 憑證");
}

export function describeAzure(json: string): string {
	try {
		const credential = parseAzure(json);
		return [credential.username, credential.subscription_name].filter(Boolean).join(" · ");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export type AzureDeviceSignIn = DeviceSignIn;

export function startAzureSignIn(): Promise<DeviceSignIn> {
	return startDeviceFlow({
		url: `${LOGIN}/organizations/oauth2/v2.0/devicecode`,
		form: { client_id: CLIENT_ID, scope: `${ARM_SCOPE} offline_access openid profile` },
		what: "Azure 登入",
	});
}

/** Poll until the user enters the code; then pick the tenant and subscription az will use. */
export async function finishAzureSignIn(signIn: DeviceSignIn, signal: AbortSignal): Promise<string> {
	const tokens = await pollDeviceFlow({
		signIn,
		url: `${LOGIN}/organizations/oauth2/v2.0/token`,
		form: { client_id: CLIENT_ID },
		what: "Microsoft",
		signal,
	});
	if (!tokens.refresh) throw new Error("Azure 登入失敗：沒有拿到 refresh token");
	const claims = parse(SignInClaims, jwtPayload(tokens.idToken ?? tokens.access.token), "Microsoft ID token");
	// The first subscription decides the tenant; without one, the sign-in's own tenant.
	const response = await getJson({
		url: "https://management.azure.com/subscriptions?api-version=2022-12-01",
		token: tokens.access.token,
		what: "Azure 訂閱清單",
	});
	const subscription = parse(Subscriptions, response.body, "Azure 訂閱清單").value[0];
	return JSON.stringify({
		type: "azure",
		refresh_token: tokens.refresh,
		tenant_id: subscription?.tenantId ?? claims.tid ?? "",
		username: claims.preferred_username ?? claims.upn,
		subscription_id: subscription?.subscriptionId,
		subscription_name: subscription?.displayName,
	} satisfies AzureCredential);
}

/** Access tokens per resource scope; Microsoft may rotate the refresh token, which `onRotate` persists. */
export class AzureTokens {
	#credential: AzureCredential;
	readonly #onRotate: (json: string) => Promise<void>;
	readonly #cache = new Map<string, AccessToken>();
	readonly #pending = new Map<string, Promise<AccessToken>>();

	constructor(json: string, onRotate: (json: string) => Promise<void>) {
		this.#credential = parseAzure(json);
		this.#onRotate = onRotate;
	}

	/** What the sandbox's placeholder tokens and az's profile need: tenant and subscription. */
	get env(): Record<string, string> {
		return {
			AZURE_TENANT_ID: this.#credential.tenant_id,
			...(this.#credential.subscription_id ? { AZURE_SUBSCRIPTION_ID: this.#credential.subscription_id } : {}),
		};
	}

	get(scope = ARM_SCOPE): Promise<AccessToken> {
		const cached = this.#cache.get(scope);
		if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return Promise.resolve(cached);
		let pending = this.#pending.get(scope);
		if (!pending) {
			pending = this.#refresh(scope).finally(() => this.#pending.delete(scope));
			this.#pending.set(scope, pending);
		}
		return pending;
	}

	async #refresh(scope: string): Promise<AccessToken> {
		const credential = this.#credential;
		const response = await postForm({
			url: `${LOGIN}/${credential.tenant_id}/oauth2/v2.0/token`,
			form: { grant_type: "refresh_token", refresh_token: credential.refresh_token, client_id: CLIENT_ID, scope: `${scope} offline_access` },
			what: "Azure token",
		});
		let tokens;
		try {
			tokens = tokensFrom(response, "Azure token");
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}（可能需要在設定重新登入）`);
		}
		if (tokens.refresh && tokens.refresh !== credential.refresh_token) {
			this.#credential = { ...credential, refresh_token: tokens.refresh };
			await this.#onRotate(JSON.stringify(this.#credential));
		}
		this.#cache.set(scope, tokens.access);
		return tokens.access;
	}
}
