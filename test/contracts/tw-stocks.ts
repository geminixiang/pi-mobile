import assert from "node:assert/strict";
import { findListing, flowsFrom, indexFrom, type Listing, listingsFrom, marginsFrom, pricesFrom, revenuesFrom, totalsFrom, valuationsFrom } from "../../src/agent/tools/tw-stocks.ts";
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
		"valuation reads P/E, P/B and yield on both markets, where TPEx sends some cells as numbers",
		async () => {
			const twse = valuationsFrom("twse", "2026-10-22", { stat: "OK", data: [["2330", "台積電", "2,385.00", "0.92", 114, "27.65", "9.61", "115/2"], ["2801", "彰銀", "20.10", "4.48", 114, "-", "1.21", "115/2"]] });
			assert.deepEqual(twse.get("2330"), { code: "2330", market: "twse", date: "2026-10-22", pe: 27.65, pb: 9.61, dividend_yield_pct: 0.92, dividend_year: "114", report_period: "115/2" });
			assert.equal(twse.get("2801")?.pe, null);
			const tpex = valuationsFrom("tpex", "2026-10-22", { tables: [{ data: [["6488", "環球晶          ", "40.10", "7.70000000", 114, "0.93", "4.08", "115Q2"]] }] });
			assert.deepEqual(tpex.get("6488"), { code: "6488", market: "tpex", date: "2026-10-22", pe: 40.1, pb: 4.08, dividend_yield_pct: 0.93, dividend_year: "114", report_period: "115Q2" });
		},
	],
	[
		"monthly revenue is in NT$ with its growth, from the month in ROC years",
		async () => {
			const revenue = revenuesFrom("twse", [
				{
					出表日期: "1151017",
					資料年月: "11509",
					公司代號: "2330",
					公司名稱: "台積電",
					"營業收入-當月營收": "511857399",
					"營業收入-上月營收": "514805337",
					"營業收入-去年當月營收": "330980920",
					"營業收入-上月比較增減(%)": "-0.5726315925897248",
					"營業收入-去年同月增減(%)": "54.64861207105231",
					"累計營業收入-當月累計營收": "3898726974",
					"累計營業收入-去年累計營收": "2762963851",
					"累計營業收入-前期比較增減(%)": "41.106694993093484",
					備註: "因先進製程產品需求增加所致。",
				},
			]).get("2330");
			assert.equal(revenue?.month, "2026-09");
			assert.equal(revenue?.revenue_twd, 511_857_399_000);
			assert.equal(revenue?.yoy_pct?.toFixed(2), "54.65");
			assert.equal(revenue?.note, "因先進製程產品需求增加所致。");
		},
	],
	[
		"the market day joins each index with its institutional totals",
		async () => {
			const twse = indexFrom("twse", { stat: "OK", data: [["115/10/22", "11,999,249,506", "933,437,473,560", "5,720,639", "46,041.43", "-846.34"]] }).get("2026-10-22");
			assert.deepEqual(twse, { market: "twse", date: "2026-10-22", index: 46041.43, change: -846.34, volume_shares: 11_999_249_506, value_twd: 933_437_473_560 });
			const tpex = indexFrom("tpex", { tables: [{ data: [["115/10/22", "1,017,848", "225,212,361", "1,170,205", 381.69, -13.73]] }] }).get("2026-10-22");
			assert.deepEqual(tpex, { market: "tpex", date: "2026-10-22", index: 381.69, change: -13.73, volume_shares: 1_017_848_000, value_twd: 225_212_361_000 });
			assert.deepEqual(
				totalsFrom("twse", {
					stat: "OK",
					data: [
						["自營商(自行買賣)", "7,229,694,959", "10,945,959,717", "-3,716,264,758"],
						["自營商(避險)", "34,944,625,822", "58,605,725,671", "-23,661,099,849"],
						["投信", "25,263,632,690", "15,771,432,172", "9,492,200,518"],
						["外資及陸資(不含外資自營商)", "304,133,658,440", "385,715,759,892", "-81,582,101,452"],
						["外資自營商", "0", "0", "0"],
						["合計", "371,571,611,911", "471,038,877,452", "-99,467,265,541"],
					],
				}),
				{ foreign_net_twd: -81_582_101_452, trust_net_twd: 9_492_200_518, dealer_net_twd: -27_377_364_607, total_net_twd: -99_467_265_541 },
			);
			assert.deepEqual(
				totalsFrom("tpex", {
					tables: [
						{
							data: [
								["外資及陸資合計", "70,074,184,990", "76,073,380,543", "-5,999,195,553"],
								["\u3000外資及陸資(不含自營商)", "70,074,184,990", "76,073,380,543", "-5,999,195,553"],
								["投信", "4,361,720,141", "5,069,480,215", "-707,760,074"],
								["自營商合計", "5,546,775,169", "7,756,970,104", "-2,210,194,935"],
								["\u3000自營商(自行買賣)", "1,329,334,593", "2,475,058,666", "-1,145,724,073"],
								["三大法人合計*", "79,982,680,300", "88,899,830,862", "-8,917,150,562"],
							],
						},
					],
				}),
				{ foreign_net_twd: -5_999_195_553, trust_net_twd: -707_760_074, dealer_net_twd: -2_210_194_935, total_net_twd: -8_917_150_562 },
			);
		},
	],
	[
		"a stock is found by code, Yahoo symbol, or name on either market, and an unclear name asks for the code",
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
			assert.deepEqual(findListing(listings, "2330.TW"), tsmc);
			assert.deepEqual(findListing(listings, "6488.two"), gwc);
			assert.deepEqual(findListing(listings, "環球晶"), gwc);
			assert.equal(findListing(listings, "高股息").code, "0056");
			assert.throws(() => findListing(listings, "元大"), /several stocks: 0050 元大台灣50, 0056 元大高股息/);
			assert.throws(() => findListing(listings, "鴻海"), /no listed or OTC stock/);
		},
	],
];
