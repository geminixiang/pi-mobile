import { type Static, Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { DAY, defineAppTool, getJson, localDate, oneOf, parseDay, startOfToday, text } from "./common.ts";
import { parse } from "../parse.ts";
import { sharedUntilFailure } from "../../promise.ts";

type Market = "twse" | "tpex";
type Daily = "institutional" | "margin";
export type Listing = { code: string; name: string; market: Market };

const MAX_REQUESTS = 24;
const LOOKBACK_DAYS = 10;

const Rows = Type.Array(Type.Array(Type.String()));
const TwseReport = Type.Object({ stat: Type.String(), data: Type.Optional(Rows) });
const TwseTables = Type.Object({ stat: Type.String(), tables: Type.Optional(Type.Array(Type.Object({ data: Type.Optional(Rows) }))) });
const TpexTables = Type.Object({ tables: Type.Array(Type.Object({ data: Type.Optional(Rows) })) });
const TwseListings = Type.Array(Type.Object({ Code: Type.String(), Name: Type.String() }));
const TpexListings = Type.Array(Type.Object({ SecuritiesCompanyCode: Type.String(), CompanyName: Type.String() }));

const twseReport = (what: string) => (body: unknown) => parse(TwseReport, body, what).data ?? [];
const twseTable = (index: number, what: string) => (body: unknown) => parse(TwseTables, body, what).tables?.[index]?.data ?? [];
const tpexTable = (what: string) => (body: unknown) => parse(TpexTables, body, what).tables[0]?.data ?? [];
const compact = (date: string) => date.replaceAll("-", "");
const slashed = (date: string) => date.replaceAll("-", "/");

const MARKETS = {
	twse: {
		label: "上市",
		lot: 1,
		prices: { url: (code: string, month: string) => `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${compact(month)}01&stockNo=${code}&response=json`, rows: twseReport("TWSE daily prices") },
		institutional: {
			url: (date: string) => `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compact(date)}&selectType=ALLBUT0999&response=json`,
			rows: twseReport("TWSE institutional trading"),
			columns: { foreign: [4, 7], trust: 10, dealer: 11, total: 18 },
		},
		margin: {
			url: (date: string) => `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${compact(date)}&selectType=STOCK&response=json`,
			rows: twseTable(1, "TWSE margin trading"),
			columns: { marginBefore: 5, margin: 6, shortBefore: 11, short: 12 },
		},
	},
	tpex: {
		label: "上櫃",
		lot: 1000,
		prices: { url: (code: string, month: string) => `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${slashed(month)}/01&response=json`, rows: tpexTable("TPEx daily prices") },
		institutional: {
			url: (date: string) => `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slashed(date)}&response=json`,
			rows: tpexTable("TPEx institutional trading"),
			columns: { foreign: [10], trust: 13, dealer: 22, total: 23 },
		},
		margin: {
			url: (date: string) => `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${slashed(date)}&response=json`,
			rows: tpexTable("TPEx margin trading"),
			columns: { marginBefore: 2, margin: 6, shortBefore: 10, short: 14 },
		},
	},
} as const;

const Nullable = Type.Union([Type.Number(), Type.Null()]);
const Stock = { code: Type.String(), name: Type.String(), market: oneOf(["twse", "tpex"]), date: Type.String() };
const Price = Type.Object({ ...Stock, open: Nullable, high: Nullable, low: Nullable, close: Nullable, change: Nullable, volume_shares: Type.Number(), value_twd: Type.Number(), trades: Type.Number() });
const Flow = Type.Object({ ...Stock, foreign_net: Type.Number(), trust_net: Type.Number(), dealer_net: Type.Number(), total_net: Type.Number() });
const Margin = Type.Object({ ...Stock, margin_balance: Type.Number(), margin_change: Type.Number(), short_balance: Type.Number(), short_change: Type.Number() });
type Price = Static<typeof Price>;
type Flow = Static<typeof Flow>;
type Margin = Static<typeof Margin>;
type DailyRow<T> = Omit<T, "name">;

const number = (value: string | undefined) => Number((value ?? "").replace(/[^\d.-]/g, "")) || 0;
const price = (value: string | undefined) => (/\d/.test(value ?? "") ? number(value) : null);
const rocDate = (value: string) => {
	const [year = "", month = "", day = ""] = value.trim().split("/");
	return `${Number(year) + 1911}-${month}-${day}`;
};

export function listingsFrom(twse: unknown, tpex: unknown): Listing[] {
	return [
		...parse(TwseListings, twse, "TWSE listings").map((item): Listing => ({ code: item.Code.trim(), name: item.Name.trim(), market: "twse" })),
		...parse(TpexListings, tpex, "TPEx listings").map((item): Listing => ({ code: item.SecuritiesCompanyCode.trim(), name: item.CompanyName.trim(), market: "tpex" })),
	];
}

export function pricesFrom(stock: Listing, body: unknown): Price[] {
	const { lot, prices } = MARKETS[stock.market];
	return prices.rows(body).map(([date = "", volume, value, open, high, low, close, change, trades]) => ({
		...stock,
		date: rocDate(date),
		open: price(open),
		high: price(high),
		low: price(low),
		close: price(close),
		change: price(change),
		volume_shares: number(volume) * lot,
		value_twd: number(value) * lot,
		trades: number(trades),
	}));
}

function byCode<T>(rows: readonly string[][], fields: (row: readonly string[]) => T): Map<string, T & { code: string }> {
	return new Map(
		rows.map((row) => {
			const code = (row[0] ?? "").trim();
			return [code, { code, ...fields(row) }];
		}),
	);
}

export function flowsFrom(market: Market, date: string, body: unknown): Map<string, DailyRow<Flow>> {
	const { rows, columns } = MARKETS[market].institutional;
	return byCode(rows(body), (row) => ({
		market,
		date,
		foreign_net: columns.foreign.reduce((sum, column) => sum + number(row[column]), 0),
		trust_net: number(row[columns.trust]),
		dealer_net: number(row[columns.dealer]),
		total_net: number(row[columns.total]),
	}));
}

export function marginsFrom(market: Market, date: string, body: unknown): Map<string, DailyRow<Margin>> {
	const { rows, columns } = MARKETS[market].margin;
	return byCode(rows(body), (row) => ({
		market,
		date,
		margin_balance: number(row[columns.margin]),
		margin_change: number(row[columns.margin]) - number(row[columns.marginBefore]),
		short_balance: number(row[columns.short]),
		short_change: number(row[columns.short]) - number(row[columns.shortBefore]),
	}));
}

export function findListing(listings: readonly Listing[], wanted: string): Listing {
	const query = wanted.trim();
	const exact = listings.find((listing) => listing.code === query.toUpperCase() || listing.name === query);
	if (exact) return exact;
	const close = listings.filter((listing) => listing.name.includes(query));
	const [only] = close;
	if (only && close.length === 1) return only;
	if (close.length > 1) throw new Error(`"${wanted}" matches several stocks: ${close.slice(0, 8).map((listing) => `${listing.code} ${listing.name}`).join(", ")}; give the code`);
	throw new Error(`no listed or OTC stock is called "${wanted}"; give its code`);
}

const directories = new Map<string, Promise<Listing[]>>();

function listings(signal: AbortSignal | undefined): Promise<Listing[]> {
	const today = localDate(Date.now());
	for (const day of directories.keys()) if (day !== today) directories.delete(day);
	return sharedUntilFailure(directories, today, async () => {
		const [twse, tpex] = await Promise.all([
			getJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", "TWSE listings", signal),
			getJson("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes", "TPEx listings", signal),
		]);
		return listingsFrom(twse, tpex);
	});
}

function weekdays(from: number, to: number): string[] {
	const days: string[] = [];
	for (let at = new Date(from); at.getTime() <= to; at.setDate(at.getDate() + 1)) if (at.getDay() !== 0 && at.getDay() !== 6) days.push(localDate(at.getTime()));
	return days;
}

function months(from: number, to: number): string[] {
	const found: string[] = [];
	for (let at = new Date(new Date(from).setDate(1)); at.getTime() <= to; at.setMonth(at.getMonth() + 1)) found.push(localDate(at.getTime()).slice(0, 7));
	return found;
}

function withinBudget(requests: number, narrow: string): void {
	if (requests > MAX_REQUESTS) throw new Error(`that needs ${requests} requests to TWSE/TPEx, more than ${MAX_REQUESTS}; ${narrow}`);
}

const marketsOf = (stocks: readonly Listing[]) => [...new Set(stocks.map((stock) => stock.market))];

async function prices(stocks: readonly Listing[], from: number, to: number, signal: AbortSignal | undefined): Promise<Price[]> {
	const spans = months(from, to);
	withinBudget(stocks.length * spans.length, "ask for fewer stocks or a shorter range");
	const perMarket = await Promise.all(
		marketsOf(stocks).map(async (market) => {
			const rows: Price[] = [];
			for (const stock of stocks.filter((candidate) => candidate.market === market)) {
				for (const month of spans) rows.push(...pricesFrom(stock, await getJson(MARKETS[market].prices.url(stock.code, month), `${stock.code} prices`, signal)));
			}
			return rows;
		}),
	);
	return perMarket.flat().filter((row) => row.date >= localDate(from) && row.date <= localDate(to));
}

type DailySource<T> = { kind: Daily; read: (market: Market, date: string, body: unknown) => Map<string, DailyRow<T>> };
const INSTITUTIONAL: DailySource<Flow> = { kind: "institutional", read: flowsFrom };
const MARGIN: DailySource<Margin> = { kind: "margin", read: marginsFrom };

async function daily<T>(source: DailySource<T>, stocks: readonly Listing[], days: readonly string[], latest: boolean, signal: AbortSignal | undefined): Promise<(DailyRow<T> & { name: string })[]> {
	withinBudget(days.length * marketsOf(stocks).length, "ask for a shorter range");
	const rows: (DailyRow<T> & { name: string })[] = [];
	const missing = new Set(stocks);
	for (const date of days) {
		const wanted = latest ? [...missing] : stocks;
		const tables = await Promise.all(marketsOf(wanted).map(async (market) => source.read(market, date, await getJson(MARKETS[market][source.kind].url(date), `${source.kind} ${date}`, signal))));
		const found = new Map(tables.flatMap((table) => [...table]));
		for (const stock of wanted) {
			const row = found.get(stock.code);
			if (!row) continue;
			rows.push({ ...row, name: stock.name });
			missing.delete(stock);
		}
		if (latest && missing.size === 0) break;
	}
	return rows;
}

const signed = (value: number) => (value > 0 ? `+${value.toLocaleString("en-US")}` : value.toLocaleString("en-US"));
const lots = (shares: number) => Math.round(shares / 1000).toLocaleString("en-US");

const twStocks = defineAppTool({
	name: "tw_stocks",
	description:
		"Taiwan stock market after-hours data from TWSE and TPEx (listed 上市 and OTC 上櫃 stocks and ETFs), published after the close: daily prices, institutional investors' (三大法人) net buying, or margin trading (融資融券) balances. Use it instead of searching the web for Taiwan stock data.",
	parameters: Type.Object({
		data: oneOf(["prices", "institutional", "margin"], {
			description: "prices: daily open, high, low, close, change and volume; institutional: foreign, investment trust and dealer net buying in shares; margin: margin and short balances in lots (張)",
		}),
		stocks: Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: "Stock codes or names: 2330, 台積電, 0050" }),
		from: Type.Optional(Type.String({ description: "First date YYYY-MM-DD; default 30 days ago for prices, else the latest trading day" })),
		to: Type.Optional(Type.String({ description: "Last date YYYY-MM-DD; default today" })),
	}),
	structuredOutputSchema: Type.Object({ rows: Type.Union([Type.Array(Price), Type.Array(Flow), Type.Array(Margin)]) }),
	replay: "safe",
	execute: async (args, _api, context) => {
		const signal = context.abortSignal;
		const directory = await listings(signal);
		const stocks = args.stocks.map((wanted) => findListing(directory, wanted));
		const to = args.to ? parseDay(args.to, "to") : startOfToday();
		const header = stocks.map((stock) => `${stock.code} ${stock.name}（${MARKETS[stock.market].label}）`).join("、");
		const reply = (rows: Price[] | Flow[] | Margin[], lines: string[], empty: string) => ({
			...text(rows.length === 0 ? `${header}: ${empty}` : [header, ...lines].join("\n")),
			structuredOutput: { rows },
		});
		if (args.data === "prices") {
			const rows = await prices(stocks, args.from ? parseDay(args.from, "from") : to - 30 * DAY, to, signal);
			const lines = rows.map((row) => `${row.date} ${row.code} ${row.name} ${row.open ?? "-"} ${row.high ?? "-"} ${row.low ?? "-"} ${row.close ?? "-"} ${row.change === null ? "-" : signed(row.change)} ${lots(row.volume_shares)}`);
			return reply(rows, ["date code name open high low close change volume(lots)", ...lines], "no trading days in that range.");
		}
		const latest = args.from === undefined;
		const days = args.from === undefined ? weekdays(to - LOOKBACK_DAYS * DAY, to).reverse() : weekdays(parseDay(args.from, "from"), to);
		const empty = `no ${args.data} data ${latest ? `in the ${LOOKBACK_DAYS} days to ${localDate(to)}` : "in that range"}; TWSE/TPEx publish it after the close (institutional about 15:00, margin about 21:00).`;
		if (args.data === "institutional") {
			const rows = await daily(INSTITUTIONAL, stocks, days, latest, signal);
			const lines = rows.map((row) => `${row.date} ${row.code} ${row.name} ${signed(row.foreign_net)} ${signed(row.trust_net)} ${signed(row.dealer_net)} ${signed(row.total_net)}`);
			return reply(rows, ["date code name foreign trust dealer total (net shares)", ...lines], empty);
		}
		const rows = await daily(MARGIN, stocks, days, latest, signal);
		const lines = rows.map((row) => `${row.date} ${row.code} ${row.name} ${row.margin_balance.toLocaleString("en-US")} (${signed(row.margin_change)}) ${row.short_balance.toLocaleString("en-US")} (${signed(row.short_change)})`);
		return reply(rows, ["date code name margin-balance (change) short-balance (change) (lots)", ...lines], empty);
	},
});

export const TwStocksExtension = defineExtension({
	name: "tw_stocks",
	tools: [twStocks],
});
