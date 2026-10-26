import { type Static, Type } from "typebox";
import { type AccessToken, type DeviceSignIn, getJson, jwtPayload, pollDeviceFlow, refreshRotating, startDeviceFlow, cachedToken } from "./oauth.ts";
import { type Checked, checkJson, parse } from "./parse.ts";

const LOGIN = "https://login.microsoftonline.com";
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
type AzureCredential = Static<typeof AzureCredential>;

const SignInClaims = Type.Object({
	tid: Type.Optional(Type.String()),
	preferred_username: Type.Optional(Type.String()),
	upn: Type.Optional(Type.String()),
});
const Subscriptions = Type.Object({
	value: Type.Array(Type.Object({ subscriptionId: Type.String(), displayName: Type.String(), tenantId: Type.String() })),
});

export function checkAzureCredential(json: string): Checked<AzureCredential> {
	return checkJson(AzureCredential, json, "Azure 憑證");
}

export function describeAzure(json: string): string {
	const checked = checkAzureCredential(json);
	return checked.ok ? [checked.value.username, checked.value.subscription_name].filter(Boolean).join(" · ") : checked.problem;
}

export function startAzureSignIn(): Promise<DeviceSignIn> {
	return startDeviceFlow({
		url: `${LOGIN}/organizations/oauth2/v2.0/devicecode`,
		form: { client_id: CLIENT_ID, scope: `${ARM_SCOPE} offline_access openid profile` },
		what: "Azure 登入",
	});
}

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

export class AzureTokens {
	#credential: AzureCredential;
	readonly #onRotate: (json: string) => Promise<void>;
	readonly #tokens = new Map<string, () => Promise<AccessToken>>();

	constructor(credential: AzureCredential, onRotate: (json: string) => Promise<void>) {
		this.#credential = credential;
		this.#onRotate = onRotate;
	}

	get env(): Record<string, string> {
		return {
			AZURE_TENANT_ID: this.#credential.tenant_id,
			...(this.#credential.subscription_id ? { AZURE_SUBSCRIPTION_ID: this.#credential.subscription_id } : {}),
		};
	}

	get(scope = ARM_SCOPE): Promise<AccessToken> {
		const token = this.#tokens.get(scope) ?? cachedToken(() => this.#refresh(scope));
		this.#tokens.set(scope, token);
		return token();
	}

	#refresh(scope: string): Promise<AccessToken> {
		const credential = this.#credential;
		return refreshRotating(
			{
				url: `${LOGIN}/${credential.tenant_id}/oauth2/v2.0/token`,
				refreshToken: credential.refresh_token,
				form: { client_id: CLIENT_ID, scope: `${scope} offline_access` },
				what: "Azure token",
			},
			async (refresh_token) => {
				this.#credential = { ...credential, refresh_token };
				await this.#onRotate(JSON.stringify(this.#credential));
			},
		);
	}
}
