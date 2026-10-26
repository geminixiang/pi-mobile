import assert from "node:assert/strict";
import { findListing, flowsFrom, type Listing, listingsFrom, marginsFrom, pricesFrom } from "../../src/agent/tools/tw-stocks.ts";
import type { Check } from "./setup.ts";

const tsmc: Listing = { code: "2330", name: "台積電", market: "twse" };
const gwc: Listing = { code: "6488", name: "環球晶", market: "tpex" };
const NO_DATA = { stat: "很抱歉，沒有符合條件的資料!", total: 0 };

export const checks: Check[] = [
	[
		"TWSE and TPEx daily prices read as one shape, in shares and dates",
		async () => {
			const twse = pricesFrom(tsmc, {
				stat: "OK",
				data: [["115/10/01", "20,666,092", "51,702,445,610", "2,490.00", "2,510.00", "2,485.00", "2,510.00", "+30.00", "57,634", ""]],
			});
			assert.deepEqual(twse, [
				{ ...tsmc, date: "2026-10-01", open: 2490, high: 2510, low: 2485, close: 2510, change: 30, volume_shares: 20_666_092, value_twd: 51_702_445_610, trades: 57_634 },
			]);
			const tpex = pricesFrom(gwc, { tables: [{ data: [["115/10/22", "10,521", "8,963,825", "896.00", "898.00", "815.00", "826.00", "-54.00", "49,523"]] }] });
			assert.equal(tpex[0]?.volume_shares, 10_521_000);
			assert.equal(tpex[0]?.value_twd, 8_963_825_000);
			assert.equal(tpex[0]?.change, -54);
			assert.deepEqual(pricesFrom(tsmc, { stat: "OK", data: [["115/10/02", "0", "0", "--", "--", "--", "--", "X0.00", "0", ""]] })[0]?.close, null);
		},
	],
	[
		"institutional net buying adds up the same way on both markets",
		async () => {
			const twse = flowsFrom("twse", "2026-10-22", {
				stat: "OK",
				data: [["2330", "台積電          ", "12,403,967", "25,098,593", "-12,694,626", "0", "0", "0", "1,370,000", "20,049", "1,349,951", "1,195,500", "190,854", "479,840", "-288,986", "1,592,141", "107,655", "1,484,486", "-10,149,175"]],
			}).get("2330");
			assert.deepEqual(twse, { code: "2330", market: "twse", date: "2026-10-22", foreign_net: -12_694_626, trust_net: 1_349_951, dealer_net: 1_195_500, total_net: -10_149_175 });
			assert.equal((twse?.foreign_net ?? 0) + (twse?.trust_net ?? 0) + (twse?.dealer_net ?? 0), twse?.total_net);
			const tpex = flowsFrom("tpex", "2026-10-22", {
				tables: [
					{
						data: [["6488", "環球晶", "1,929,231", "4,028,737", "-2,099,506", "0", "0", "0", "1,929,231", "4,028,737", "-2,099,506", "4,000", "208,000", "-204,000", "45,000", "98,199", "-53,199", "614,015", "845,738", "-231,723", "659,015", "943,937", "-284,922", "-2,588,428"]],
					},
				],
			}).get("6488");
			assert.equal((tpex?.foreign_net ?? 0) + (tpex?.trust_net ?? 0) + (tpex?.dealer_net ?? 0), tpex?.total_net);
			assert.equal(flowsFrom("twse", "2026-10-25", NO_DATA).size, 0);
			assert.equal(flowsFrom("tpex", "2026-10-25", { tables: [{ data: [] }, {}] }).size, 0);
		},
	],
	[
		"margin balances and their day's change, in lots",
		async () => {
			const twse = marginsFrom("twse", "2026-10-22", {
				stat: "OK",
				tables: [{}, { data: [["　", "合計", "216,658", "269,074", "9,030", "6,690,788", "6,629,342", "192,949,111", "15,513", "21,881", "760", "118,948", "124,556", "192,949,111", "4,258", "　"], ["2330", "台積電", "597", "434", "21", "35,330", "35,472", "6,483,092", "1", "10", "0", "6", "15", "6,483,092", "0", " "]] }],
			});
			assert.deepEqual(twse.get("2330"), { code: "2330", market: "twse", date: "2026-10-22", margin_balance: 35_472, margin_change: 142, short_balance: 15, short_change: 9 });
			const tpex = marginsFrom("tpex", "2026-10-22", {
				tables: [{ data: [["6488", "環球晶", "13,071", "576", "670", "19", "12,958", "231", "9.81", "132,028", "176", "18", "9", "0", "185", "0", "0.14", "132,028", "3", ""]] }],
			});
			assert.deepEqual(tpex.get("6488"), { code: "6488", market: "tpex", date: "2026-10-22", margin_balance: 12_958, margin_change: -113, short_balance: 185, short_change: 9 });
			assert.equal(marginsFrom("twse", "2026-10-25", NO_DATA).size, 0);
		},
	],
	[
		"a stock is found by code or name on either market, and an unclear name asks for the code",
		async () => {
			const listings = listingsFrom(
				[
					{ Code: "2330", Name: "台積電" },
					{ Code: "0050", Name: "元大台灣50" },
					{ Code: "0056", Name: "元大高股息" },
				],
				[{ SecuritiesCompanyCode: "6488", CompanyName: "環球晶" }],
			);
			assert.deepEqual(findListing(listings, "2330"), tsmc);
			assert.deepEqual(findListing(listings, "環球晶"), gwc);
			assert.equal(findListing(listings, "高股息").code, "0056");
			assert.throws(() => findListing(listings, "元大"), /several stocks: 0050 元大台灣50, 0056 元大高股息/);
			assert.throws(() => findListing(listings, "鴻海"), /no listed or OTC stock/);
		},
	],
];
