import type { ReactNode } from "react";
import type { Settings } from "../settings.ts";
import { AzureMark, CloudflareMark, GitHubMark, GoogleCloudMark } from "pi-mobile-ui/elements";
import { describeAzure } from "./azure.ts";
import { describeCloudflare } from "./cloudflare.ts";
import { describeGcloud } from "./gcloud.ts";

export type AccountId = "github" | "gcloud" | "cloudflare" | "azure";

type Account = {
	id: AccountId;
	name: string;
	short: string;
	mark: ReactNode;
	credential: "githubToken" | "gcloudCredential" | "cloudflareCredential" | "azureCredential";
	describe: (credential: string) => string;
	removed: Partial<Settings>;
};

export const ACCOUNTS: readonly Account[] = [
	{ id: "github", name: "GitHub", short: "GH", mark: <GitHubMark />, credential: "githubToken", describe: () => "已填 token", removed: { githubToken: "" } },
	{ id: "gcloud", name: "Google Cloud", short: "GC", mark: <GoogleCloudMark />, credential: "gcloudCredential", describe: describeGcloud, removed: { gcloudCredential: "", gcloudProject: "" } },
	{ id: "cloudflare", name: "Cloudflare", short: "CF", mark: <CloudflareMark />, credential: "cloudflareCredential", describe: describeCloudflare, removed: { cloudflareCredential: "" } },
	{ id: "azure", name: "Azure", short: "AZ", mark: <AzureMark />, credential: "azureCredential", describe: describeAzure, removed: { azureCredential: "" } },
];

export const linked = (account: Account, settings: Settings): boolean => settings[account.credential] !== "";

export const signedIn = (account: Account, settings: Settings): string => (linked(account, settings) ? account.describe(settings[account.credential]) : "");
