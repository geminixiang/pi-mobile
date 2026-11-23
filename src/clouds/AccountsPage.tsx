import { useState } from "react";
import { checkGitHub } from "../agent/checks.ts";
import type { Settings } from "../settings.ts";
import { CheckButton, RowList } from "pi-mobile-ui/elements";
import { Sheet } from "pi-mobile-ui/shell";
import { type AccountId, ACCOUNTS, signedIn } from "./accounts.tsx";
import { finishAzureSignIn, startAzureSignIn } from "./azure.ts";
import { apiTokenCredential, finishCloudflareSignIn, startCloudflareSignIn } from "./cloudflare.ts";
import { checkGcloud } from "./gcloud.ts";
import { DeviceSignInPanel, GoogleSignInPanel } from "./SignIn.tsx";

export function AccountsPage({ settings, change }: { settings: Settings; change: (next: Partial<Settings>) => void }) {
	const [open, setOpen] = useState<AccountId>();
	const accounts = ACCOUNTS.map((account) => ({ ...account, signedIn: signedIn(account, settings) }));
	const shown = accounts.find((account) => account.id === open);
	return (
		<>
			<RowList title="Bot 用你的身分登入">
				{accounts.map((account) => (
					<button type="button" key={account.id} onClick={() => setOpen(account.id)}>
						{account.mark}
						<span className="menu-text">
							{account.name}
							<span className="index-status">{account.signedIn || "還沒登入"}</span>
						</span>
						<i className={`row-dot${account.signedIn ? "" : " off"}`} />
					</button>
				))}
			</RowList>
			<Sheet open={shown !== undefined} title={shown?.name ?? ""} onClose={() => setOpen(undefined)}>
				{shown ? (
					<div className="sheet-form">
						{shown.id === "github" ? (
							<>
								<label>
									<span>Token</span>
									<input
										value={settings.githubToken}
										onChange={(event) => change({ githubToken: event.target.value.trim() })}
										type="password"
										autoComplete="off"
										placeholder="github_pat_…"
									/>
								</label>
								<CheckButton disabled={!settings.githubToken} run={() => checkGitHub(settings.githubToken)} />
							</>
						) : null}
						{shown.id === "gcloud" ? (
							<>
								{settings.gcloudCredential ? null : (
									<>
										<GoogleSignInPanel onCredential={(json) => change({ gcloudCredential: json })} />
										<details className="manual">
											<summary>改用 service account 金鑰</summary>
											<label>
												<span>憑證 JSON</span>
												<textarea
													className="field json"
													rows={4}
													value={settings.gcloudCredential}
													onChange={(event) => change({ gcloudCredential: event.target.value.trim() })}
													placeholder="service account 金鑰或 application_default_credentials.json"
													autoCapitalize="off"
													spellCheck={false}
												/>
											</label>
										</details>
									</>
								)}
								<label>
									<span>預設專案</span>
									<input
										value={settings.gcloudProject}
										onChange={(event) => change({ gcloudProject: event.target.value.trim() })}
										placeholder="憑證本身的專案"
										autoCapitalize="off"
										autoComplete="off"
									/>
								</label>
								<CheckButton disabled={!settings.gcloudCredential} run={() => checkGcloud(settings.gcloudCredential)} />
							</>
						) : null}
						{shown.id === "cloudflare" ? (
							settings.cloudflareCredential ? null : (
								<>
									<DeviceSignInPanel provider="Cloudflare" start={startCloudflareSignIn} finish={finishCloudflareSignIn} onCredential={(json) => change({ cloudflareCredential: json })} />
									<details className="manual">
										<summary>改用 API token</summary>
										<label>
											<span>API token</span>
											<input
												type="password"
												autoComplete="off"
												onChange={(event) => {
													const token = event.target.value.trim();
													if (token.length >= 40) change({ cloudflareCredential: apiTokenCredential(token) });
												}}
											/>
										</label>
									</details>
								</>
							)
						) : null}
						{shown.id === "azure" ? (
							settings.azureCredential ? null : (
								<DeviceSignInPanel provider="Microsoft" start={startAzureSignIn} finish={finishAzureSignIn} copyCode onCredential={(json) => change({ azureCredential: json })} />
							)
						) : null}
						{shown.signedIn ? (
							<button
								type="button"
								className="danger-verb"
								onClick={() => {
									setOpen(undefined);
									change(shown.removed);
								}}
							>
								移除
							</button>
						) : null}
					</div>
				) : null}
			</Sheet>
		</>
	);
}
