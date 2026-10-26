import { type Static, Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { DAY, defineAppTool, getJson, localDate, oneOf, parseDay, startOfToday, text } from "./common.ts";
import { parse } from "../parse.ts";
import { sharedUntilFailure } from "../../promise.ts";

const MARKET_IDS = ["twse", "tpex"] as const;
type Market = (typeof MARKET_IDS)[number];
type Daily = "institutional" | "margin" | "valuation";
type Cell = string | number | undefined;
export type Listing = { code: string; name: string; market: Market };

const MAX_REQUESTS = 24;
const LOOKBACK_DAYS = 10;

const Rows = Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()])));
const TwseReport = Type.Object({ stat: Type.String(), data: Type.Optional(Rows) });
const TwseTables = Type.Object({ stat: Type.String(), tables: Type.Optional(Type.Array(Type.Object({ data: Type.Optional(Rows) }))) });
const TpexTables = Type.Object({ tables: Type.Array(Type.Object({ data: Type.Optional(Rows) })) });
const TwseListings = Type.Array(Type.Object({ Code: Type.String(), Name: Type.String() }));
const TpexListings = Type.Array(Type.Object({ SecuritiesCompanyCode: Type.String(), CompanyName: Type.String() }));
const Revenues = Type.Array(
	Type.Object({
		資料年月: Type.String(),
		公司代號: Type.String(),
		"營業收入-當月營收": Type.String(),
		"營業收入-上月比較增減(%)": Type.String(),
		"營業收入-去年同月增減(%)": Type.String(),
		"累計營業收入-當月累計營收": Type.String(),
		"累計營業收入-前期比較增減(%)": Type.String(),
		備註: Type.Optional(Type.String()),
	}),
);

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
		valuation: {
			url: (date: string) => `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${compact(date)}&selectType=ALL&response=json`,
			rows: twseReport("TWSE valuation"),
			columns: { pe: 5, pb: 6, yield: 3, dividendYear: 4, report: 7 },
		},
		revenue: "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
		index: { url: (month: string) => `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${compact(month)}01&response=json`, rows: twseReport("TWSE index") },
		totals: {
			url: (date: string) => `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${compact(date)}&response=json`,
			rows: twseReport("TWSE institutional totals"),
			labels: { foreign: (label: string) => label.startsWith("外資"), dealer: (label: string) => label.startsWith("自營商"), total: (label: string) => label === "合計" },
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
		valuation: {
			url: (date: string) => `https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=${slashed(date)}&response=json`,
			rows: tpexTable("TPEx valuation"),
			columns: { pe: 2, pb: 6, yield: 5, dividendYear: 4, report: 7 },
		},
		revenue: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
		index: { url: (month: string) => `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${slashed(month)}/01&response=json`, rows: tpexTable("TPEx index") },
		totals: {
			url: (date: string) => `https://www.tpex.org.tw/www/zh-tw/insti/summary?type=Daily&date=${slashed(date)}&response=json`,
			rows: tpexTable("TPEx institutional totals"),
			labels: { foreign: (label: string) => label === "外資及陸資合計", dealer: (label: string) => label === "自營商合計", total: (label: string) => label.startsWith("三大法人合計") },
		},
	},
} as const;

const Nullable = Type.Union([Type.Number(), Type.Null()]);
const Stock = { code: Type.String(), name: Type.String(), market: oneOf(MARKET_IDS), date: Type.String() };
const Price = Type.Object({ ...Stock, open: Nullable, high: Nullable, low: Nullable, close: Nullable, change: Nullable, volume_shares: Type.Number(), value_twd: Type.Number(), trades: Type.Number() });
const Flow = Type.Object({ ...Stock, foreign_net: Type.Number(), trust_net: Type.Number(), dealer_net: Type.Number(), total_net: Type.Number() });
const Margin = Type.Object({ ...Stock, margin_balance: Type.Number(), margin_change: Type.Number(), short_balance: Type.Number(), short_change: Type.Number() });
const Valuation = Type.Object({ ...Stock, pe: Nullable, pb: Nullable, dividend_yield_pct: Nullable, dividend_year: Type.String(), report_period: Type.String() });
const Revenue = Type.Object({
	code: Type.String(),
	name: Type.String(),
	market: oneOf(MARKET_IDS),
	month: Type.String(),
	revenue_twd: Type.Number(),
	mom_pct: Nullable,
	yoy_pct: Nullable,
	year_to_date_twd: Type.Number(),
	year_to_date_yoy_pct: Nullable,
	note: Type.String(),
});
const MarketDay = Type.Object({
	market: oneOf(MARKET_IDS),
	date: Type.String(),
	index: Nullable,
	change: Nullable,
	volume_shares: Type.Number(),
	value_twd: Type.Number(),
	foreign_net_twd: Nullable,
	trust_net_twd: Nullable,
	dealer_net_twd: Nullable,
	total_net_twd: Nullable,
});
type Price = Static<typeof Price>;
type Flow = Static<typeof Flow>;
type Margin = Static<typeof Margin>;
type Valuation = Static<typeof Valuation>;
type Revenue = Static<typeof Revenue>;
type MarketDay = Static<typeof MarketDay>;
type DailyRow<T> = Omit<T, "name">;
type IndexDay = Pick<MarketDay, "market" | "date" | "index" | "change" | "volume_shares" | "value_twd">;

const number = (value: Cell) => Number(String(value ?? "").replace(/[^\d.-]/g, "")) || 0;
const price = (value: Cell) => (/\d/.test(String(value ?? "")) ? number(value) : null);
const rocDate = (value: Cell) => {
	const [year = "", month = "", day = ""] = String(value ?? "").trim().split("/");
	return `${Number(year) + 1911}-${month}-${day}`;
};
const rocMonth = (value: string) => `${Number(value.slice(0, -2)) + 1911}-${value.slice(-2)}`;

export function listingsFrom(twse: unknown, tpex: unknown): Listing[] {
	return [
		...parse(TwseListings, twse, "TWSE listings").map((item): Listing => ({ code: item.Code.trim(), name: item.Name.trim(), market: "twse" })),
		...parse(TpexListings, tpex, "TPEx listings").map((item): Listing => ({ code: item.SecuritiesCompanyCode.trim(), name: item.CompanyName.trim(), market: "tpex" })),
	];
}

export function pricesFrom(stock: Listing, body: unknown): Price[] {
	const { lot, prices } = MARKETS[stock.market];
	return prices.rows(body).map(([date, volume, value, open, high, low, close, change, trades]) => ({
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

function byCode<T>(rows: readonly Cell[][], fields: (row: readonly Cell[]) => T): Map<string, T & { code: string }> {
	return new Map(
		rows.map((row) => {
			const code = String(row[0] ?? "").trim();
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

export function valuationsFrom(market: Market, date: string, body: unknown): Map<string, DailyRow<Valuation>> {
	const { rows, columns } = MARKETS[market].valuation;
	return byCode(rows(body), (row) => ({
		market,
		date,
		pe: price(row[columns.pe]),
		pb: price(row[columns.pb]),
		dividend_yield_pct: price(row[columns.yield]),
		dividend_year: String(row[columns.dividendYear] ?? ""),
		report_period: String(row[columns.report] ?? ""),
	}));
}

export function revenuesFrom(market: Market, body: unknown): Map<string, Omit<Revenue, "name">> {
	return new Map(
		parse(Revenues, body, `${market} monthly revenue`).map((item) => {
			const code = item.公司代號.trim();
			return [
				code,
				{
					code,
					market,
					month: rocMonth(item.資料年月),
					revenue_twd: number(item["營業收入-當月營收"]) * 1000,
					mom_pct: price(item["營業收入-上月比較增減(%)"]),
					yoy_pct: price(item["營業收入-去年同月增減(%)"]),
					year_to_date_twd: number(item["累計營業收入-當月累計營收"]) * 1000,
					year_to_date_yoy_pct: price(item["累計營業收入-前期比較增減(%)"]),
					note: (item.備註 ?? "").trim(),
				},
			];
		}),
	);
}

export function indexFrom(market: Market, body: unknown): Map<string, IndexDay> {
	const { index, lot } = MARKETS[market];
	return new Map(
		index.rows(body).map(([day, volume, value, , close, change]) => {
			const date = rocDate(day);
			return [date, { market, date, index: price(close), change: price(change), volume_shares: number(volume) * lot, value_twd: number(value) * lot }];
		}),
	);
}

export function totalsFrom(market: Market, body: unknown): Pick<MarketDay, "foreign_net_twd" | "trust_net_twd" | "dealer_net_twd" | "total_net_twd"> {
	const { rows, labels } = MARKETS[market].totals;
	const nets = rows(body).map((row) => ({ label: String(row[0] ?? "").trim(), net: number(row[3]) }));
	const sum = (matches: (label: string) => boolean) => {
		const found = nets.filter((row) => matches(row.label));
		return found.length === 0 ? null : found.reduce((total, row) => total + row.net, 0);
	};
	return { foreign_net_twd: sum(labels.foreign), trust_net_twd: sum((label) => label === "投信"), dealer_net_twd: sum(labels.dealer), total_net_twd: sum(labels.total) };
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

function todays<V>(cache: Map<string, Promise<V>>, scope: string, load: () => Promise<V>): Promise<V> {
	const key = `${scope} ${localDate(Date.now())}`;
	for (const cached of cache.keys()) if (cached.startsWith(`${scope} `) && cached !== key) cache.delete(cached);
	return sharedUntilFailure(cache, key, load);
}

const directories = new Map<string, Promise<Listing[]>>();

function listings(signal: AbortSignal | undefined): Promise<Listing[]> {
	return todays(directories, "all", async () => {
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

async function daily<T>(
	kind: Daily,
	read: (market: Market, date: string, body: unknown) => Map<string, DailyRow<T>>,
	stocks: readonly Listing[],
	days: readonly string[],
	latest: boolean,
	signal: AbortSignal | undefined,
): Promise<(DailyRow<T> & { name: string })[]> {
	withinBudget(days.length * marketsOf(stocks).length, "ask for a shorter range");
	const rows: (DailyRow<T> & { name: string })[] = [];
	const missing = new Set(stocks);
	for (const date of days) {
		const wanted = latest ? [...missing] : stocks;
		const tables = await Promise.all(
			marketsOf(wanted).map(async (market) => ({ market, table: read(market, date, await getJson(MARKETS[market][kind].url(date), `${kind} ${date}`, signal)) })),
		);
		const published = new Set(tables.filter(({ table }) => table.size > 0).map(({ market }) => market));
		const found = new Map(tables.flatMap(({ table }) => [...table]));
		for (const stock of wanted) {
			const row = found.get(stock.code);
			if (row) rows.push({ ...row, name: stock.name });
			if (published.has(stock.market)) missing.delete(stock);
		}
		if (latest && missing.size === 0) break;
	}
	return rows;
}

const revenueLists = new Map<string, Promise<Map<string, Omit<Revenue, "name">>>>();

function revenueList(market: Market, signal: AbortSignal | undefined): Promise<Map<string, Omit<Revenue, "name">>> {
	return todays(revenueLists, market, async () => revenuesFrom(market, await getJson(MARKETS[market].revenue, `${market} monthly revenue`, signal)));
}

async function revenues(stocks: readonly Listing[], signal: AbortSignal | undefined): Promise<Revenue[]> {
	const tables = await Promise.all(marketsOf(stocks).map((market) => revenueList(market, signal)));
	const found = new Map(tables.flatMap((table) => [...table]));
	return stocks.flatMap((stock) => {
		const row = found.get(stock.code);
		return row ? [{ ...row, name: stock.name }] : [];
	});
}

async function marketDays(days: readonly string[], latest: boolean, signal: AbortSignal | undefined): Promise<MarketDay[]> {
	const spans = [...new Set(days.map((day) => day.slice(0, 7)))];
	withinBudget(MARKET_IDS.length * (spans.length + (latest ? 1 : days.length)), "ask for a shorter range");
	const indexes = await Promise.all(
		MARKET_IDS.map(async (market) => {
			const found = new Map<string, IndexDay>();
			for (const month of spans) for (const [date, row] of indexFrom(market, await getJson(MARKETS[market].index.url(month), `${market} index`, signal))) found.set(date, row);
			return found;
		}),
	);
	const trading = days.filter((day) => indexes.some((found) => found.has(day)));
	const rows: MarketDay[] = [];
	for (const date of latest ? trading.slice(0, 1) : trading) {
		const perMarket = await Promise.all(
			MARKET_IDS.map(async (market, at) => {
				const index = indexes[at]?.get(date);
				return index ? [{ ...index, ...totalsFrom(market, await getJson(MARKETS[market].totals.url(date), `${market} totals ${date}`, signal)) }] : [];
			}),
		);
		rows.push(...perMarket.flat());
	}
	return rows;
}

const signed = (value: number) => (value > 0 ? `+${value.toLocaleString("en-US")}` : value.toLocaleString("en-US"));
const lots = (shares: number) => Math.round(shares / 1000).toLocaleString("en-US");
const hundredMillions = (twd: number | null) => (twd === null ? "-" : `${twd > 0 ? "+" : ""}${(twd / 1e8).toFixed(1)}`);
const pct = (value: number | null) => (value === null ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`);

const twStocks = defineAppTool({
	name: "tw_stocks",
	effect: "read",
	description:
		"Taiwan stock market after-hours data from TWSE and TPEx (listed 上市 and OTC 上櫃 stocks and ETFs), published after the close: daily prices, institutional investors' (三大法人) net buying, margin trading (融資融券), valuation (P/E, P/B, yield), monthly revenue (月營收), or the whole market (加權指數, 櫃買指數, turnover, 三大法人 totals). Use it instead of searching the web for Taiwan stock data.",
	parameters: Type.Object({
		data: oneOf(["prices", "institutional", "margin", "valuation", "revenue", "market"], {
			description:
				"prices: daily open, high, low, close, change and volume; institutional: foreign, investment trust and dealer net buying in shares; margin: margin and short balances in lots (張); valuation: P/E, P/B and dividend yield; revenue: the latest month's revenue with month-on-month, year-on-year and year-to-date growth; market: both indexes, turnover and institutional net buying in NT$, no stocks needed",
		}),
		stocks: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: "Stock codes or names: 2330, 台積電, 0050; required except for market" })),
		from: Type.Optional(Type.String({ description: "First date YYYY-MM-DD; default 30 days ago for prices, else the latest trading day; not used for revenue; institutional, margin, valuation and market cover about 10 trading days per call" })),
		to: Type.Optional(Type.String({ description: "Last date YYYY-MM-DD; default today" })),
	}),
	structuredOutputSchema: Type.Object({ rows: Type.Union([Type.Array(Price), Type.Array(Flow), Type.Array(Margin), Type.Array(Valuation), Type.Array(Revenue), Type.Array(MarketDay)]) }),
	replay: "safe",
	execute: async (args, _api, context) => {
		const signal = context.abortSignal;
		const to = args.to ? parseDay(args.to, "to") : startOfToday();
		const from = args.from === undefined ? undefined : parseDay(args.from, "from");
		const latest = from === undefined;
		const days = from === undefined ? weekdays(to - LOOKBACK_DAYS * DAY, to).reverse() : weekdays(from, to);
		const unpublished = `${latest ? `in the ${LOOKBACK_DAYS} days to ${localDate(to)}` : "in that range"}; TWSE/TPEx publish after the close (indexes 13:30, institutional about 15:00, margin about 21:00).`;
		if (args.data === "market") {
			const rows = await marketDays(days, latest, signal);
			const lines = rows.map(
				(row) =>
					`${row.date} ${MARKETS[row.market].label} ${row.index ?? "-"} ${row.change === null ? "-" : signed(row.change)} ${(row.value_twd / 1e8).toFixed(1)} ${hundredMillions(row.foreign_net_twd)} ${hundredMillions(row.trust_net_twd)} ${hundredMillions(row.dealer_net_twd)} ${hundredMillions(row.total_net_twd)}`,
			);
			return {
				...text(rows.length === 0 ? `no trading days ${unpublished}` : ["date market index change turnover foreign trust dealer total (NT$ 100 million, 億; - = not published yet)", ...lines].join("\n")),
				structuredOutput: { rows },
			};
		}
		if (!args.stocks) throw new Error(`stocks is required for ${args.data}`);
		const directory = await listings(signal);
		const stocks = args.stocks.map((wanted) => findListing(directory, wanted));
		const header = stocks.map((stock) => `${stock.code} ${stock.name}（${MARKETS[stock.market].label}）`).join("、");
		const reply = (rows: Price[] | Flow[] | Margin[] | Valuation[] | Revenue[], lines: string[], empty: string) => {
			const absent = stocks.filter((stock) => !rows.some((row) => row.code === stock.code)).map((stock) => `${stock.code} ${stock.name}`);
			const note = rows.length > 0 && absent.length > 0 ? [`no ${args.data} data for ${absent.join(", ")}${args.data === "valuation" ? " (ETFs have no P/E)" : ""}`] : [];
			return { ...text(rows.length === 0 ? `${header}: ${empty}` : [header, ...lines, ...note].join("\n")), structuredOutput: { rows } };
		};
		if (args.data === "prices") {
			const rows = await prices(stocks, from ?? to - 30 * DAY, to, signal);
			const lines = rows.map((row) => `${row.date} ${row.code} ${row.name} ${row.open ?? "-"} ${row.high ?? "-"} ${row.low ?? "-"} ${row.close ?? "-"} ${row.change === null ? "-" : signed(row.change)} ${lots(row.volume_shares)}`);
			return reply(rows, ["date code name open high low close change volume(lots)", ...lines], "no trading days in that range.");
		}
		if (args.data === "revenue") {
			const rows = await revenues(stocks, signal);
			const lines = rows.map((row) => `${row.month} ${row.code} ${row.name} ${(row.revenue_twd / 1e8).toFixed(1)} ${pct(row.mom_pct)} ${pct(row.yoy_pct)} ${(row.year_to_date_twd / 1e8).toFixed(1)} ${pct(row.year_to_date_yoy_pct)}${row.note ? ` ${row.note}` : ""}`);
			return reply(rows, ["month code name revenue MoM YoY year-to-date YoY note (NT$ 100 million, 億; the latest month published, around the 10th)", ...lines], "no monthly revenue published.");
		}
		const empty = `no ${args.data} data ${unpublished}`;
		if (args.data === "institutional") {
			const rows = await daily<Flow>("institutional", flowsFrom, stocks, days, latest, signal);
			const lines = rows.map((row) => `${row.date} ${row.code} ${row.name} ${signed(row.foreign_net)} ${signed(row.trust_net)} ${signed(row.dealer_net)} ${signed(row.total_net)}`);
			return reply(rows, ["date code name foreign trust dealer total (net shares)", ...lines], empty);
		}
		if (args.data === "valuation") {
			const rows = await daily<Valuation>("valuation", valuationsFrom, stocks, days, latest, signal);
			const lines = rows.map((row) => `${row.date} ${row.code} ${row.name} ${row.pe ?? "-"} ${row.pb ?? "-"} ${row.dividend_yield_pct ?? "-"}% ${row.dividend_year} ${row.report_period}`);
			return reply(rows, ["date code name P/E P/B yield dividend-year report (P/E - = loss or no earnings)", ...lines], empty);
		}
		const rows = await daily<Margin>("margin", marginsFrom, stocks, days, latest, signal);
		const lines = rows.map((row) => `${row.date} ${row.code} ${row.name} ${row.margin_balance.toLocaleString("en-US")} (${signed(row.margin_change)}) ${row.short_balance.toLocaleString("en-US")} (${signed(row.short_change)})`);
		return reply(rows, ["date code name margin-balance (change) short-balance (change) (lots)", ...lines], empty);
	},
});

export const TwStocksExtension = defineExtension({
	name: "tw_stocks",
	tools: [twStocks],
});
