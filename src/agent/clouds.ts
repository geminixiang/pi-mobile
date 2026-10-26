import { AzureTokens, checkAzureCredential } from "./azure.ts";
import { checkCloudflareCredential, CloudflareTokens } from "./cloudflare.ts";
import { checkGcloudCredential, GcloudTokens } from "./gcloud.ts";
import type { MintedService } from "./sandbox/container.ts";
import { azureService, type CloudService, cloudflareService, googleService } from "./tools/cloud.ts";
import type { Settings } from "../settings.ts";
import type { RotatedCredentials } from "./platform.ts";

export function connectClouds(settings: Settings, rotated: RotatedCredentials): { minted: Record<string, MintedService>; services: CloudService[] } {
	const gcloudCredential = settings.gcloudCredential ? checkGcloudCredential(settings.gcloudCredential) : undefined;
	const cloudflareCredential = settings.cloudflareCredential ? checkCloudflareCredential(settings.cloudflareCredential) : undefined;
	const azureCredential = settings.azureCredential ? checkAzureCredential(settings.azureCredential) : undefined;
	const gcloud = gcloudCredential?.ok ? new GcloudTokens(gcloudCredential.value) : undefined;
	const cloudflare = cloudflareCredential?.ok ? new CloudflareTokens(cloudflareCredential.value, rotated.cloudflare) : undefined;
	const azure = azureCredential?.ok ? new AzureTokens(azureCredential.value, rotated.azure) : undefined;
	const project = settings.gcloudProject || gcloud?.project;
	const minted: Record<string, MintedService> = {};
	const services: CloudService[] = [];
	if (gcloud) {
		minted.gcloud = { get: () => gcloud.get(), env: project ? { CLOUDSDK_CORE_PROJECT: project } : {} };
		services.push(googleService(async () => (await gcloud.get()).token, project));
	}
	if (cloudflare) {
		minted.cloudflare = { get: () => cloudflare.get(), env: cloudflare.accountId ? { CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId } : {} };
		services.push(cloudflareService(async () => (await cloudflare.get()).token, cloudflare.accountId));
	}
	if (azure) {
		minted.azure = { get: (scope) => azure.get(scope), env: azure.env };
		services.push(azureService(async (scope) => (await azure.get(scope)).token, azure.env.AZURE_SUBSCRIPTION_ID));
	}
	return { minted, services };
}
