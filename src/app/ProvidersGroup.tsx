import { Row } from "./Row.tsx";
import { useState } from "react";
import { checkModels, checkProvider } from "../agent/checks.ts";
import type { ModelInfo } from "../agent/models.ts";
import { BUILTIN_PROVIDERS, builtinInfo, customId, type ProviderConfig, providerName } from "../agent/providers.ts";
import type { Settings } from "../settings.ts";
import { signInWithChatGPT } from "../agent/chatgpt.ts";
import { native } from "../native.ts";
import { System } from "../plugins/system.ts";
import { CheckButton } from "./CheckButton.tsx";
import { RowList } from "./RowList.tsx";
import { ChoiceRow } from "./ChoiceRow.tsx";
import { Logo } from "./Logo.tsx";
import { Sheet } from "./Sheet.tsx";
import { messageOf } from "../promise.ts";
import { hostOf } from "../parse.ts";

type ProviderSettings = Pick<Settings, "providers" | "providerKeys" | "providerOAuth" | "defaultProvider" | "defaultModelId">;

function ChatGPTSignIn({ signIn, onSignIn }: { signIn: string; onSignIn: (json: string) => void }) {
	const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string }>({ kind: "idle" });
	if (signIn) {
		return (
			<Row label="已用 ChatGPT 登入">
				<button type="button" className="btn" onClick={() => onSignIn("")}>
					登出
				</button>
			</Row>
		);
	}
	return (
		<div className="check-row">
			<span className="menu-text">
				或用 ChatGPT 訂閱
				{state.kind === "error" ? <span className="menu-hint error">{state.message}</span> : null}
			</span>
			<button
				type="button"
				className="btn"
				disabled={state.kind === "busy"}
				onClick={() => {
					setState({ kind: "busy" });
					signInWithChatGPT((url) => System.openExternal({ url }))
						.then((credential) => {
							setState({ kind: "idle" });
							onSignIn(JSON.stringify(credential));
						})
						.catch((error: unknown) => setState({ kind: "error", message: messageOf(error) }));
				}}
			>
				{state.kind === "busy" ? "登入中…" : "登入"}
			</button>
		</div>
	);
}

function AddProvider({ open, taken, onAdd, onClose }: { open: boolean; taken: readonly ProviderConfig[]; onAdd: (config: ProviderConfig) => void; onClose: () => void }) {
	const available = BUILTIN_PROVIDERS.filter((info) => !taken.some((config) => config.id === info.id));
	return (
		<Sheet open={open} title="新增供應商" onClose={onClose}>
			<div className="menu">
				<button type="button" onClick={() => onAdd({ kind: "custom", id: customId(taken), name: "", baseUrl: "" })}>
					<span className="menu-text">
						自訂端點
						<span className="menu-hint">OpenAI 或 Anthropic 相容的 API</span>
					</span>
				</button>
				{available.map((info) => (
					<button type="button" key={info.id} onClick={() => onAdd({ kind: "builtin", id: info.id })}>
						<span className="menu-text">{info.name}</span>
					</button>
				))}
			</div>
		</Sheet>
	);
}

function ProviderForm({
	config,
	apiKey,
	signIn,
	onConfig,
	onKey,
	onSignIn,
	onRemove,
}: {
	config: ProviderConfig;
	apiKey: string;
	signIn: string;
	onConfig: (config: ProviderConfig) => void;
	onKey: (key: string) => void;
	onSignIn: (json: string) => void;
	onRemove: () => void;
}) {
	const info = config.kind === "builtin" ? builtinInfo(config.id) : undefined;
	return (
		<div className="sheet-form">
			{config.kind === "custom" ? (
				<>
					<label>
						<span>網址</span>
						<input
							value={config.baseUrl}
							onChange={(event) => onConfig({ ...config, baseUrl: event.target.value.trim() })}
							placeholder="https://mac.xxxx.ts.net:8318"
							autoCapitalize="off"
							autoComplete="off"
							inputMode="url"
						/>
					</label>
					<label>
						<span>名稱</span>
						<input value={config.name} onChange={(event) => onConfig({ ...config, name: event.target.value })} placeholder="選填" autoComplete="off" />
					</label>
				</>
			) : null}
			{signIn ? null : (
				<label>
					<span>API key{config.kind === "custom" ? "（選填）" : ""}</span>
					<input value={apiKey} onChange={(event) => onKey(event.target.value.trim())} type="password" autoComplete="off" />
				</label>
			)}
			{info && !signIn ? (
				<button type="button" className="link" onClick={() => void System.openExternal({ url: info.keyUrl })}>
					取得 {info.name} 的 API key
				</button>
			) : null}
			{info?.chatgpt && native.has("Loopback") ? <ChatGPTSignIn signIn={signIn} onSignIn={onSignIn} /> : null}
			<CheckButton
				disabled={!isComplete(config, apiKey, signIn)}
				run={() => (config.kind === "custom" ? checkModels(config.baseUrl, apiKey) : checkProvider(config.id, apiKey, signIn))}
			/>
			<button type="button" className="danger-verb" onClick={onRemove}>
				移除
			</button>
		</div>
	);
}

const isComplete = (config: ProviderConfig, apiKey: string, signIn: string) => (config.kind === "custom" ? Boolean(config.baseUrl) : Boolean(apiKey || signIn));

function summaryOf(config: ProviderConfig, apiKey: string, signIn: string): string {
	if (!isComplete(config, apiKey, signIn)) return config.kind === "custom" ? "還沒填網址" : "還沒填 API key";
	if (config.kind === "custom") return hostOf(config.baseUrl);
	return signIn ? "ChatGPT 訂閱" : "API key";
}

export function ProvidersGroup({
	settings,
	models,
	onChange,
}: {
	settings: ProviderSettings;
	models: readonly ModelInfo[];
	onChange: (change: Partial<ProviderSettings>) => void;
}) {
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<string>();
	const providers = settings.providers;
	const withProviders = (next: ProviderConfig[]): Partial<ProviderSettings> => ({
		providers: next,
		...(next.some((config) => config.id === settings.defaultProvider) ? {} : { defaultProvider: next[0]?.id ?? "" }),
	});
	const save = (next: ProviderConfig[]) => onChange(withProviders(next));
	const choices = providers.flatMap((config) =>
		models.filter((model) => model.provider === config.id).map((model) => ({ value: `${model.provider}\n${model.id}`, label: model.name, group: providerName(config) })),
	);
	const current = `${settings.defaultProvider}\n${settings.defaultModelId}`;
	const edited = providers.find((config) => config.id === editing);
	const keyOf = (config: ProviderConfig) => settings.providerKeys[config.id] ?? "";
	const signInOf = (config: ProviderConfig) => settings.providerOAuth[config.id] ?? "";

	return (
		<>
			<RowList title="供應商">
				{providers.map((config) => (
					<button type="button" key={config.id} onClick={() => setEditing(config.id)}>
						<Logo name={providerName(config)} />
						<span className="menu-text">
							{providerName(config)}
							<span className="index-status">{summaryOf(config, keyOf(config), signInOf(config))}</span>
						</span>
						<i className={`row-dot${isComplete(config, keyOf(config), signInOf(config)) ? "" : " off"}`} />
					</button>
				))}
				<button type="button" className="row-add" onClick={() => setAdding(true)}>
					＋ 新增供應商
				</button>
			</RowList>
			{choices.length > 0 ? (
				<RowList title="新 Bot 預設">
					<ChoiceRow
						label="模型"
						value={current}
						shown={choices.find((choice) => choice.value === current)?.label ?? (settings.defaultModelId || "選一個模型")}
						choices={choices}
						onChoose={(value) => {
							const [provider = "", modelId = ""] = value.split("\n");
							onChange({ defaultProvider: provider, defaultModelId: modelId });
						}}
					/>
				</RowList>
			) : null}
			<Sheet open={edited !== undefined} title={edited ? providerName(edited) || "自訂端點" : ""} onClose={() => setEditing(undefined)}>
				{edited ? (
					<ProviderForm
						config={edited}
						apiKey={keyOf(edited)}
						signIn={signInOf(edited)}
						onConfig={(next) => save(providers.map((item) => (item.id === edited.id ? next : item)))}
						onKey={(key) => onChange({ providerKeys: { ...settings.providerKeys, [edited.id]: key } })}
						onSignIn={(json) => onChange({ providerOAuth: { ...settings.providerOAuth, [edited.id]: json } })}
						onRemove={() => {
							setEditing(undefined);
							const { [edited.id]: _key, ...keys } = settings.providerKeys;
							const { [edited.id]: _signIn, ...signIns } = settings.providerOAuth;
							onChange({ providerKeys: keys, providerOAuth: signIns, ...withProviders(providers.filter((item) => item.id !== edited.id)) });
						}}
					/>
				) : null}
			</Sheet>
			<AddProvider
				open={adding}
				taken={providers}
				onClose={() => setAdding(false)}
				onAdd={(config) => {
					setAdding(false);
					save([...providers, config]);
					setEditing(config.id);
				}}
			/>
		</>
	);
}
