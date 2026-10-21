// The MCP services offered in Settings › MCP › 瀏覽服務: well-known remote servers that work from the phone. Each was
// probed on 2026-10-21: it answered without sign-in, or its OAuth accepted dynamic registration with the loopback
// redirect (mcp.ts REDIRECT_URL). "tested" marks those also signed in and used on the S24. The official MCP Registry
// lists some 7,000 remote servers of every quality; this list is the ones worth showing first. docs/tools.md says how
// one gets in.

export type CatalogCategory = "work" | "dev" | "knowledge" | "business" | "automation";

export const CATEGORIES: Record<CatalogCategory, string> = {
	work: "工作與筆記",
	knowledge: "查資料",
	dev: "開發",
	business: "商務",
	automation: "自動化",
};

export interface CatalogEntry {
	name: string;
	url: string;
	category: CatalogCategory;
	/** What a bot can do with it, in a line. */
	description: string;
	/** "oauth": the user signs in with the service's account in the browser. */
	auth: "none" | "oauth";
	/** Signed in and used on the S24, beyond the probe. */
	tested?: true;
}

export const CATALOG: readonly CatalogEntry[] = [
	{ name: "Notion", url: "https://mcp.notion.com/mcp", category: "work", auth: "oauth", description: "搜尋、讀寫你的 Notion 頁面與資料庫" },
	{ name: "Linear", url: "https://mcp.linear.app/mcp", category: "work", auth: "oauth", description: "查詢、建立與更新 issue 和專案" },
	{ name: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", category: "work", auth: "oauth", description: "Jira 的 issue 與 Confluence 的頁面" },
	{ name: "Asana", url: "https://mcp.asana.com/mcp", category: "work", auth: "oauth", description: "任務、專案與團隊的進度" },
	{ name: "Monday", url: "https://mcp.monday.com/mcp", category: "work", auth: "oauth", description: "monday.com 的看板與項目" },
	{ name: "Todoist", url: "https://ai.todoist.net/mcp", category: "work", auth: "oauth", description: "待辦清單：新增、完成、查今天要做什麼" },
	{ name: "Airtable", url: "https://mcp.airtable.com/mcp", category: "work", auth: "oauth", description: "Airtable 的資料表與紀錄" },
	{ name: "Context7", url: "https://mcp.context7.com/mcp", category: "knowledge", auth: "none", description: "各種程式庫最新版的官方文件" },
	{ name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", category: "knowledge", auth: "none", description: "解說任何公開 GitHub repo 的架構與用法" },
	{ name: "Exa", url: "https://mcp.exa.ai/mcp", category: "knowledge", auth: "none", description: "給 AI 用的網路搜尋，找文章、公司、論文" },
	{ name: "Hugging Face", url: "https://huggingface.co/mcp", category: "knowledge", auth: "none", description: "搜尋模型、資料集、論文與 Spaces" },
	{ name: "Cloudflare 文件", url: "https://docs.mcp.cloudflare.com/mcp", category: "knowledge", auth: "none", description: "Cloudflare 官方文件搜尋", tested: true },
	{ name: "Cloudflare", url: "https://bindings.mcp.cloudflare.com/mcp", category: "dev", auth: "oauth", description: "Workers、D1、KV、R2 與 Hyperdrive", tested: true },
	{ name: "Cloudflare 監控", url: "https://observability.mcp.cloudflare.com/mcp", category: "dev", auth: "oauth", description: "Workers 的記錄與錯誤" },
	{ name: "Sentry", url: "https://mcp.sentry.dev/mcp", category: "dev", auth: "oauth", description: "錯誤與效能問題的追查" },
	{ name: "Supabase", url: "https://mcp.supabase.com/mcp", category: "dev", auth: "oauth", description: "Supabase 專案的資料庫、函式與記錄" },
	{ name: "Neon", url: "https://mcp.neon.tech/mcp", category: "dev", auth: "oauth", description: "Neon 的 Postgres 資料庫與分支" },
	{ name: "Vercel", url: "https://mcp.vercel.com", category: "dev", auth: "oauth", description: "Vercel 專案的部署與記錄" },
	{ name: "Stripe", url: "https://mcp.stripe.com", category: "business", auth: "oauth", description: "付款、客戶、訂閱與退款" },
	{ name: "PayPal", url: "https://mcp.paypal.com/mcp", category: "business", auth: "oauth", description: "交易、發票與爭議" },
	{ name: "Square", url: "https://mcp.squareup.com/mcp", category: "business", auth: "oauth", description: "Square 的訂單、商品與付款" },
	{ name: "Intercom", url: "https://mcp.intercom.com/mcp", category: "business", auth: "oauth", description: "客服對話與聯絡人" },
	{ name: "Wix", url: "https://mcp.wix.com/mcp", category: "business", auth: "oauth", description: "Wix 網站、商店與預約" },
	{ name: "Webflow", url: "https://mcp.webflow.com/mcp", category: "business", auth: "oauth", description: "Webflow 網站與 CMS 內容" },
	{ name: "Canva", url: "https://mcp.canva.com/mcp", category: "business", auth: "oauth", description: "找、建立與匯出 Canva 設計" },
	{ name: "Zapier", url: "https://mcp.zapier.com/api/mcp/mcp", category: "automation", auth: "oauth", description: "透過 Zapier 串接上千種 App 的動作" },
];
