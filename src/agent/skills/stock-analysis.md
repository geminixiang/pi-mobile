# Stock analysis

For questions about stocks, ETFs, or the market: how something has moved, who is buying, whether it is cheap, what
changed today, or a recurring digest of the user's watchlist.

## Where the numbers come from

- Taiwan, after the close: `tw_stocks`; one call covers about 10 trading days of `institutional`, `margin`,
  `valuation` or `market`, and months of `prices`. `prices` (daily OHLC, volume), `institutional` (三大法人 net shares),
  `margin` (融資融券 in 張), `valuation` (本益比, 股價淨值比, 殖利率), `revenue` (the latest 月營收 with 月增, 年增,
  累計), `market` (加權 and 櫃買 indexes, turnover, 三大法人 net NT$). Its structured `rows` are for scripts.
- Taiwan, during the session (09:00–13:30): an intraday quote service, if this bot has one (台股開放資料
  `quote_realtime`, also its market snapshot and futures). Otherwise say the price is the last close.
- US: a US stock data service, if this bot has one (Shibui Finance: read its schema and query patterns once, then SQL).
  Without one, say so instead of guessing figures.
- News, reasons, events: `web_search`, after the numbers, and say which is which.
- Get every series a question needs in one codemode script (`Promise.all`), and compute there; return a compact
  table, not the raw rows.

## Taiwan conventions

- 1 張 = 1,000 shares. Daily limit ±10%. Dates in the sources are ROC years (115 = 2026); the tool converts them.
- Published after the close: indexes about 13:30, 三大法人 about 15:00, 融資融券 about 21:00, valuation in the
  evening; 月營收 by the 10th of the next month; quarterly reports by 5/15, 8/14, 11/14, annual by 3/31.
- No session on weekends and holidays (補假 included): when the latest date is not today, say the market was closed
  and give the date the data is from.
- A gap down on an ex-dividend day (除權息) is mostly the dividend, not a fall: before calling it a drop, check
  whether the company went ex-dividend that day (web_search).
- ETFs have no P/E; 0050-style codes are ETFs, 6-character codes ending in a letter are actively managed ETFs.

## How to read it

- Trend: close against its 5, 20, 60-day averages (60 needs about three months of `prices`), distance from the 20-day
  high and low, volume against its 20-day average. RSI(14) only when asked; compute it, never estimate it.
- Chips (籌碼): consecutive days and the N-day sum of foreign and trust net buying, in 張; trust buying matters most
  in small and mid caps. 融資 rising while the price falls is retail averaging down; 融券 and 券資比 for short pressure.
  Compare a stock's flows with the market's (`market`) before calling them unusual.
- Fundamentals: the latest 月營收 年增 against its 累計 年增 (above means accelerating; only the latest month is
  available); the P/E against the stock's own range over the last couple of weeks of `valuation` rather than a rule
  of thumb.
- One stock against the market or its peers says more than its own numbers alone.

## The answer

- Conclusion first in one or two sentences, then a short table; every figure with its date and unit (股, 張, NT$億).
- Separate what the data shows from what it might mean; name the data that would change the view.
- No buy or sell calls and no price targets of your own; if the user asks, give the factors on both sides and say it
  is their decision.
- A chart or a page to keep: read html-page first.

## Watchlist digest

When the user wants a daily summary of their stocks:

1. Keep the watchlist in memory (update_memory) under a 自選股 line, so later runs and edits share it.
2. `create_schedule` on `time` at 21:30 on mon–fri (after 融資融券 is out), with a prompt that reads the watchlist from
   memory and asks for the digest; it runs as a new turn here.
3. The digest: one line per stock (close, change, foreign and trust net 張, 融資 change), then the market line, then
   anything unusual (a limit move, the largest foreign or trust flow in the last 10 trading days, a new 20-day high or
   low from `prices`). If the data date is not today, say the market was closed and stop there.
