---
version: alpha
name: pi mobile
description: 口袋裡的 agent。安靜的製圖紙風格，直角、細線、少量的強調色，以左側欄為範本。
colors:
  primary: "#4b607c"
  primary-soft: "#4b607c1a"
  neutral: "#ebe7e4"
  neutral-deep: "#e2dcd6"
  surface: "#f4f2f0"
  surface-raised: "#e4dfda"
  on-surface: "#252f3d"
  on-surface-muted: "#5c5752"
  on-surface-faint: "#8b847d"
  line: "#8b847d59"
  error: "#b5543a"
  ok: "#4f8a5e"
  coral: "#f09082"
  blue: "#4d9abf"
  yellow: "#f1be58"
  logo-tile: "#ffffff"
  primary-dark: "#6a9fcc"
  neutral-dark: "#161d27"
  surface-dark: "#212730"
  surface-raised-dark: "#252f3d"
  on-surface-dark: "#ebe7e4"
  on-surface-muted-dark: "#9fa4ab"
  on-surface-faint-dark: "#6c737d"
  error-dark: "#e8704f"
typography:
  brand:
    fontFamily: Instrument Serif
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1
  title:
    fontFamily: system-ui
    fontSize: 19px
    fontWeight: 600
    lineHeight: 1.3
  prose:
    fontFamily: system-ui
    fontSize: 16.5px
    fontWeight: 400
    lineHeight: 1.7
  body-md:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.4
  body-sm:
    fontFamily: system-ui
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  label-md:
    fontFamily: Commit Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
  label-sm:
    fontFamily: Commit Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
rounded:
  none: 0px
  card: 36px
spacing:
  page: 20px
  drawer-inset: 40px
  row-y: 12px
  gap: 12px
  identity: 36px
components:
  list-row:
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    padding: 12px
  list-row-pressed:
    backgroundColor: "{colors.primary-soft}"
  list-row-current:
    backgroundColor: "{colors.surface-raised}"
  list-sub:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
  list-meta:
    textColor: "{colors.on-surface-faint}"
    typography: "{typography.label-sm}"
  list-action:
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
  list-add:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-md}"
    padding: 12px
  identity-tile:
    size: 36px
    rounded: "{rounded.none}"
    typography: "{typography.label-md}"
  logo-tile:
    backgroundColor: "{colors.logo-tile}"
    size: 36px
  button:
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    height: 38px
    padding: 16px
    rounded: "{rounded.none}"
  danger-action:
    textColor: "{colors.error}"
    typography: "{typography.label-md}"
  page:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
  sheet:
    backgroundColor: "{colors.surface}"
  input:
    backgroundColor: "{colors.neutral-deep}"
    height: 42px
    rounded: "{rounded.none}"
  divider:
    backgroundColor: "{colors.line}"
    height: 1px
  result-ok:
    textColor: "{colors.ok}"
    typography: "{typography.label-sm}"
  letter-tile-coral:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.on-surface}"
  letter-tile-blue:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-surface}"
  letter-tile-yellow:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.on-surface}"
  page-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.on-surface-dark}"
  sheet-dark:
    backgroundColor: "{colors.surface-dark}"
  list-row-current-dark:
    backgroundColor: "{colors.surface-raised-dark}"
  list-sub-dark:
    textColor: "{colors.on-surface-muted-dark}"
  list-meta-dark:
    textColor: "{colors.on-surface-faint-dark}"
  list-action-dark:
    textColor: "{colors.primary-dark}"
  danger-action-dark:
    textColor: "{colors.error-dark}"
---

# pi mobile

數值以 `src/app/styles.css` 的 `:root` 為準，這裡的 tokens 是它的摘要；淺色是預設，`-dark` 結尾的是深色模式。CSS 的寫法（層、特異性、動畫）見 `.pi/skills/css/SKILL.md`。

## Overview

pi 是一個住在口袋裡的 agent，畫面要像一張安靜的製圖紙：背景有淡淡的格線，內容直接畫在紙上，只有真正要按的東西才帶強調色。整體偏密，資訊一行一件，不用卡片和陰影堆出層次。

左側欄（`src/app/Drawer.tsx`）是範本：像素頭像、名稱、一行說明、右側安靜的時間，按整列進入，「＋ 新增 Bot」接在列表尾。新畫面照它做，舊畫面在改到時往它靠。

## Colors

- **Primary（Slate Blue `#4b607c`）**：唯一的強調色，用在可以按的動詞、選中的狀態、進度。一個畫面裡不要同時有好幾處搶眼的 primary。
- **Neutral（Warm Paper `#ebe7e4`）**：頁面的底，帶一點暖色。列表直接放在上面。
- **Surface（`#f4f2f0`、`#e4dfda`）**：面板和底部抽屜的底；`surface-raised` 也是選中那一列的底色。
- **On-surface 三階（ink、muted、faint）**：名稱用 ink，說明用 muted，時間、數字、小標用 faint。
- **Error、OK**：只用在結果和危險的動作，不拿來裝飾。
- **Coral、Blue、Yellow**：圖表、模型色票，以及沒有品牌圖示時字母方塊的底色（依名稱挑）。

## Typography

- **Brand**：Instrument Serif 斜體，只用在品牌字樣「pi mobile」。
- **Sans（system-ui、Noto Sans TC）**：名稱、說明、對話內容。
- **Mono（Commit Mono）**：時間、數字、小標、按鈕和列表裡的動詞（登入、重試、＋ 新增）。mono 讀起來像標註，所以它是次要的聲音。

## Layout

- 頁面左右留 `page`（20px）；左側欄留 `drawer-inset`（40px），讓它從螢幕外滑進來時內容已經在位置上。
- 列表橫跨整個寬度：一列上下 12px，元素間距 12px，左邊是 36px 的識別（頭像、品牌圖示或字母方塊）。
- 一列永遠只有一行名稱、一行說明，放不下就截斷。網址只留主機名，完整的放進詳情。
- 一排等著同一個動作的東西（例如待登入的服務）排成四欄的圖示方格。

## Elevation & Depth

扁平。層次靠底色深淺和 1px 的細線，不靠陰影。唯一的陰影是側邊欄打開時，被推開的對話卡片（`--card-shadow`）和瀏覽器面板，用來說明「它浮在上面、可以拉回來」。

## Shapes

直角。按鈕、輸入框、方塊、圖示底座都是 0 圓角；頭像是像素圖。只有兩個例外：被側邊欄推開的對話卡片（36px），和表示狀態的小圓點。

## Components

- **列表列（list-row）**：識別、名稱加一行說明、右側的 meta。按整列進入；按下時底色是 `primary-soft`，目前選中的是 `surface-raised`。
- **右側 meta**：通常是 faint 的 mono（時間、+n）。誰在使用這一項，就放他們的像素頭像（最多三個）。需要使用者處理時，換成一個 primary 的 mono 動詞。
- **識別方塊**：Bot 用像素頭像；服務用品牌圖示（npm 的 `simple-icons`，掛在 `src/agent/mcp-catalog.ts` 的條目上），放在白底方塊；沒有圖示的用字母方塊。
- **新增列（`.list-add`）**：虛線分隔，mono 的「＋ 新增 …」，接在列表尾。
- **按鈕（`.btn`）**：mono 字、細框、方括號 `[ 連接 ]`。用在表單和詳情裡，不放進列表列。
- **詳情**：從底部拉起的抽屜（`Sheet`），上面是細節，最底下是危險的動作。

## Do's and Don'ts

- Do 把列表直接放在背景上；Don't 用 `.group` 框或卡片包住列表。
- Do 用記號表示狀態（閃爍的方塊、圖示、變淡）；Don't 寫成句子（「已連線 · 23 個工具」）。
- Do 說明這一項是做什麼的；Don't 用統計數字當說明，數量收進詳情。
- Do 按整列進入，次要操作放在 `⋯` 或長按；Don't 在每一列放 `[ 移除 ]`。
- Do 把移除這類動作放在詳情最底下，用 error 色；Don't 讓它和日常操作並排。
- Do 讓一個設定只有一個地方能改（Bot 能用哪些服務，只在 Bot 面板改）；Don't 在兩個畫面各做一份開關。
- Do 用 `simple-icons` 這類現成套件取得品牌圖示；Don't 自己抓 favicon 或手畫。
