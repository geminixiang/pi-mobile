# HTML page

For anything you write as an `.html` for the user: a report, a comparison, a chart, a small tool. It opens on a
phone, in a frame with no network, and is often forwarded to someone else. Aim for a page that reads like a clean
printed document, not an app or a landing page.

## Look

- One quiet look: light background, dark text, one accent colour for emphasis and charts, greys for everything else.
  No gradients, shadows, badges, rounded cards, hero banners, or decorative English labels.
- System fonts (`system-ui, "Noto Sans TC", sans-serif`); body text 16px or more; generous line height and spacing;
  content width fits a phone without horizontal scrolling, and stays readable on a wider screen.
- Traditional Chinese throughout, matching the conversation; units and dates written the way the user writes them.

## Shape

1. Title, then one line saying what this is and the period or scope it covers.
2. The conclusion first, in one or two sentences, before any table or chart.
3. Sections in the order the reader needs them; short headings; prose only where a table or chart cannot say it.
4. A closing line on where the numbers came from and what is estimated.

## Numbers, tables, charts

- Numbers right-aligned, thousands separated, the unit stated once; totals and the key figure set bolder, not bigger.
- Charts are inline SVG drawn by you, with the value written next to each bar or slice; one accent plus greys; no 3D,
  no animation. A bar chart almost always beats a pie; a pie only for five slices or fewer.
- A table is for looking things up; a chart is for seeing a difference. Use one or the other, not both for the same
  data.

## Build

- Self-contained: CSS and JS inline, no CDN, fonts, or images fetched from the network; small images only as data
  URLs. The page must render with JavaScript disabled; JavaScript only adds a filter, a tab, or a calculation.
- Keep it small and plain enough that the user can read the source. Name the file in the user's language, by what
  it is (`本週支出.html`), and tell the user the name.
