// Settings › 模型供應商: where the models come from (agent/providers.ts). Any number of providers: pi-ai's built-in ones
// with an API key, and custom endpoints that speak the OpenAI or Anthropic API. Below them, the model a new bot uses.
import { useState } from "react";
import { checkModels, checkProvider } from "../agent/checks.ts";
import type { ModelInfo } from "../agent/models.ts";
import { BUILTIN_PROVIDERS, builtinInfo, customId, type ProviderConfig, parseProviders, providerName } from "../agent/providers.ts";
import type { Settings } from "../settings.ts";
import { signInWithChatGPT } from "../agent/chatgpt.ts";
import { System } from "../system-plugin.ts";
import { CheckButton } from "./CheckButton.tsx";
import { ChevronIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";

type ProviderSettings = Pick<Settings, "providers" | "providerKeys" | "providerOAuth" | "defaultProvider" | "defaultModelId">;

/** Sign in with ChatGPT for the OpenAI provider: a button, or who is signed in and a way out. */
function ChatGPTSignIn({ signIn, onSignIn }: { signIn: string; onSignIn: (json: string) => void }) {
	const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string }>({ kind: "idle" });
	if (signIn) {
		return (
			<div className="check-row">
				<span className="menu-text">
					已用 ChatGPT 登入
				</span>
				<button type="button" className="btn" onClick={() => onSignIn("")}>
					登出
				</button>
			</div>
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
						.catch((error: unknown) => setState({ kind: "error", message: error instanceof Error ? error.message : String(error) }));
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
						<span className="menu-text">
							{info.name}
							<span className="menu-hint">{info.chatgpt ? "用 API key，或用 ChatGPT 登入" : "用 API key"}</span>
						</span>
					</button>
				))}
			</div>
		</Sheet>
	);
}

function ProviderRow({
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
	const complete = config.kind === "custom" ? Boolean(config.baseUrl) : Boolean(apiKey || signIn);
	// Set up ones fold to a line; a new or unfinished one opens.
	const [open, setOpen] = useState(!complete);
	const summary = !complete
		? "未完成"
		: config.kind === "custom"
			? hostOf(config.baseUrl)
			: signIn
				? "ChatGPT 訂閱"
				: "API key";
	return (
		<div className="provider">
			<button type="button" className="check-row provider-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="menu-text">{providerName(config)}</span>
				<span className="index-value">{summary}</span>
				<ChevronIcon open={open} />
			</button>
			{open ? <ProviderFields config={config} info={info} apiKey={apiKey} signIn={signIn} onConfig={onConfig} onKey={onKey} onSignIn={onSignIn} onRemove={onRemove} /> : null}
		</div>
	);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function ProviderFields({
	config,
	info,
	apiKey,
	signIn,
	onConfig,
	onKey,
	onSignIn,
	onRemove,
}: {
	config: ProviderConfig;
	info: ReturnType<typeof builtinInfo>;
	apiKey: string;
	signIn: string;
	onConfig: (config: ProviderConfig) => void;
	onKey: (key: string) => void;
	onSignIn: (json: string) => void;
	onRemove: () => void;
}) {
	return (
		<>
			{config.kind === "custom" ? (
				<>
					<label>
						<span>網址</span>
						<input
							value={config.baseUrl}
							onChange={(event) => onConfig({ ...config, baseUrl: event.target.value.trim() })}
							placeholder="http://100.x.y.z:8317"
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
			{info?.chatgpt ? <ChatGPTSignIn signIn={signIn} onSignIn={onSignIn} /> : null}
			<CheckButton
				disabled={config.kind === "custom" ? !config.baseUrl : !apiKey && !signIn}
				run={() => (config.kind === "custom" ? checkModels(config.baseUrl, apiKey) : checkProvider(config.id, apiKey, signIn))}
			>
				<button type="button" className="btn" onClick={onRemove}>
					移除
				</button>
			</CheckButton>
		</>
	);
}

export function ProvidersGroup({
	settings,
	models,
	onChange,
}: {
	settings: ProviderSettings;
	/** The running agent's models, for the default; none before the first start. */
	models: readonly ModelInfo[];
	onChange: (change: Partial<ProviderSettings>) => void;
}) {
	const [adding, setAdding] = useState(false);
	const providers = parseProviders(settings.providers);
	const save = (next: ProviderConfig[]) => {
		const change: Partial<ProviderSettings> = { providers: JSON.stringify(next) };
		if (!next.some((config) => config.id === settings.defaultProvider)) change.defaultProvider = next[0]?.id ?? "";
		onChange(change);
	};
	const groups = providers
		.map((config) => ({ config, models: models.filter((model) => model.provider === config.id) }))
		.filter((group) => group.models.length > 0);
	const current = JSON.stringify([settings.defaultProvider, settings.defaultModelId]);

	return (
		<>
			{providers.map((config, index) => (
				<ProviderRow
					key={config.id}
					config={config}
					apiKey={settings.providerKeys[config.id] ?? ""}
					signIn={settings.providerOAuth[config.id] ?? ""}
					onConfig={(next) => save(providers.map((item, i) => (i === index ? next : item)))}
					onKey={(key) => onChange({ providerKeys: { ...settings.providerKeys, [config.id]: key } })}
					onSignIn={(json) => onChange({ providerOAuth: { ...settings.providerOAuth, [config.id]: json } })}
					onRemove={() => {
						const { [config.id]: _key, ...keys } = settings.providerKeys;
						const { [config.id]: _signIn, ...signIns } = settings.providerOAuth;
						onChange({ providerKeys: keys, providerOAuth: signIns });
						save(providers.filter((_, i) => i !== index));
					}}
				/>
			))}
			<button type="button" className="btn" onClick={() => setAdding(true)}>
				新增供應商
			</button>
			{groups.length > 0 ? (
				<label>
					<span>新 Bot 的預設模型</span>
					<select
						className="field"
						value={current}
						onChange={(event) => {
							const value: unknown = JSON.parse(event.target.value);
							if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
								onChange({ defaultProvider: value[0], defaultModelId: value[1] });
							}
						}}
					>
						{groups.some(({ models: list }) => list.some((model) => JSON.stringify([model.provider, model.id]) === current)) ? null : (
							<option value={current}>{settings.defaultModelId || "選一個模型"}</option>
						)}
						{groups.map(({ config, models: list }) => (
							<optgroup key={config.id} label={providerName(config)}>
								{list.map((model) => (
									<option key={model.id} value={JSON.stringify([model.provider, model.id])}>
										{model.name}
									</option>
								))}
							</optgroup>
						))}
					</select>
				</label>
			) : null}
			<AddProvider
				open={adding}
				taken={providers}
				onClose={() => setAdding(false)}
				onAdd={(config) => {
					setAdding(false);
					save([...providers, config]);
				}}
			/>
		</>
	);
}
