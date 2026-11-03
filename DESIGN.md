---
version: alpha
name: pi mobile
description: 口袋裡的 agent。安靜的製圖紙風格：內容直角、浮起來的一層圓角，細線、少量的強調色，以左側欄為範本。
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
  violet: "#b5a5e8"
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
  status-pill:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.none}"
    padding: 4px
  inline-verb:
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
  context-part-messages:
    backgroundColor: "{colors.primary}"
  context-part-prompt:
    backgroundColor: "{colors.yellow}"
  context-part-memory:
    backgroundColor: "{colors.ok}"
  context-part-tools:
    backgroundColor: "{colors.coral}"
  context-part-services:
    backgroundColor: "{colors.violet}"
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

每個畫面的資訊分三層，先想好每樣東西屬於哪一層再排版：

1. **一眼看到**：這是什麼、現在的狀態。名稱、時間、一個表示結果的記號。
2. **點開才看到**：細節和次要的動作。完整規則、上次的經過、立即執行。
3. **設定時才需要**：開關、暫停、權限、移除。收在詳情裡，或設定頁。

## Colors

- **Primary（Slate Blue `#4b607c`）**：唯一的強調色，用在可以按的動詞、選中的狀態、進度。一個畫面裡不要同時有好幾處搶眼的 primary。
- **Neutral（Warm Paper `#ebe7e4`）**：頁面的底，帶一點暖色。列表直接放在上面。
- **Surface（`#f4f2f0`、`#e4dfda`）**：底部抽屜的底；`surface-raised` 也是選中那一列的底色。
- **On-surface 三階（ink、muted、faint）**：名稱用 ink，說明用 muted，時間、數字、小標用 faint。
- **Error、OK**：只用在結果和危險的動作，不拿來裝飾。
- **Coral、Blue、Yellow、Violet**：圖表和分類（上下文各部分的顏色），以及沒有品牌圖示時字母方塊的底色（依名稱挑）。

## Typography

- **Brand**：Instrument Serif 斜體，只用在品牌字樣「pi mobile」。
- **Sans（system-ui、Noto Sans TC）**：名稱、說明、對話內容。
- **Mono（Commit Mono）**：時間、數字、小標、按鈕和行內的動詞（登入、重試、壓縮、＋ 新增）。mono 讀起來像標註，所以它是次要的聲音。時間要對齊時，一律用 mono。
- **字重只有 400 和 700**：Android 的中文字型沒有 500、600，寫了會退回 400，只有英文數字變粗；要粗就用 700（Stylelint 擋下其他值）。

## Layout

- 頁面左右留 `page`（20px）；左側欄留 `drawer-inset`（40px），讓它從螢幕外滑進來時內容已經在位置上；右側欄左右各留 28px。
- **區塊**：一個畫面分成幾區，每區只有一個 mono 的小標（`.list-label`），內容直接放在背景上，區與區之間靠留白分開。小標只有一層：區塊的標題和列表自己的分組（「今天」「之後」）不要疊在一起；分組本身就能當小標時，就不要再加區塊標題。
- **列表**橫跨整個寬度：一列上下 12px，元素間距 8–12px，左邊是識別（頭像、品牌圖示、字母方塊，或要對齊的時間）。
- **一列一行名稱、最多一行說明**，放不下就截斷。網址只留主機名，完整的放進詳情。
- **窄的地方**（右側欄約 300px）：名稱優先。右邊只放一個小記號，不放開關或按鈕；寬度不夠時，名稱可以折到第二行，但不要讓說明再折行。
- 一排等著同一個動作的東西（例如待登入的服務）排成四欄的圖示方格。

## 空間

對話在中間，左邊管 App（Bot 清單、設定），右邊管這個 Bot（上下文、自動化、記憶、工具、工作區）。

- 打開側欄：對話卡片往另一邊推開一半，側欄露出來（`SidePanel`）。
- 往深處走就沿同一個方向：從左側欄打開設定，卡片繼續往右推出畫面，設定頁從左邊滑進來，左側欄往外退、變暗；從右側欄打開記憶，卡片往左推出，記憶頁從右邊進來。這一頁屬於那一側的側欄（`SidePanel` 的 `page`），卡片、側欄和頁面由同一個數字推動（`--side-left`、`--side-right` 可以超過 1），用同一條曲線，不另加 CSS 過場。
- 頁面裡再往下一層，方向也一樣：設定的子頁從左邊進來；工作區從右邊蓋過對話，檔案和差異再從右邊蓋過工作區。上一頁往外退、變暗，兩頁同時在畫面上、一起動（`PageStack`），標題列跟著自己那一頁走。
- 返回照原路退回：頁面往它來的那一側滑走，露出剛才的那一層；再返回才回到對話。
- 每一層都能用手指退回：往頁面來的方向的反方向拖，頁面跟著手指走，放開時看位置和速度決定退回還是彈回原位；拖曳中可以反向。最上面那一層先接手，退到底才輪到下一層（子頁 → 設定 → 左側欄 → 對話；檔案 → 工作區 → 對話）。

## 震動

手指遮住畫面、或手勢確定生效的那一刻才震；一般點按不震（`haptic()`，`src/app/haptics.ts`）。

- **tick**：關上、返回、換格（側欄關、滑回上一層、手勢收掉面板、轉盤換一格）。
- **press**：打開、長按成立（側欄開、長按叫出選單、手勢拉開瀏覽器、開始語音輸入）。
- **confirm**：動作完成（複製成功、轉盤選定）。
- 不震：送出、一般按鈕、開關、捲到底、串流、背景事件、錯誤；點背景或按鈕關掉面板也不震。
- 瀏覽器的拉開、推回在裝置上用 `test/device/browser-haptics.mjs` 驗（真的觸控，`ANDROID_SERIAL` 必填）。

## Elevation & Depth

扁平。層次靠留白、底色深淺和 1px 的細線，不靠陰影，也不靠框。陰影只給浮在對話上、可以收走的那一層，用來說明「它浮在上面、可以拉回來」：被側邊欄推開的對話卡片和底部抽屜（`--card-shadow`）、瀏覽器面板、標題列的膠囊（`--pill-shadow`）。

## Shapes

內容是直角，浮起來的一層是圓角。

- **內容直角**：列表列、輸入框、`.btn`、識別方塊、圖示底座都是 0 圓角；頭像是像素圖。
- **浮在對話上的一層，露出來的那邊是圓的，貼著螢幕邊的那邊是方的**：被推開的對話卡片四角、瀏覽器面板的下緣、底部抽屜的上緣，都用 `--card-radius`（36px，接近螢幕本身的圓角）。
- **裡面的內容要離開弧線**：圓角的一層裡，標題、關閉鈕和內容共用一個內距（底部抽屜是 `--sheet-inset` 24px），不要讓文字落在弧線的範圍裡，看起來會像被角擠著。
- **浮在內容上的小元件是圓的**：標題列的膠囊（高 44px，全圓 22px）、工具方塊（16px）、確認框（14px）、抽屜和瀏覽器的手把（40×4，圓頭）、表示狀態的小圓點。

## Components

- **列表列（list-row）**：識別、名稱加一行說明、右側的 meta。按整列進入；按下時底色是 `primary-soft`，目前選中的是 `surface-raised`。
- **右側 meta**：通常是 faint 的 mono（時間、+n），或一個表示結果的小記號（✓ ✕ ⏭）。誰在使用這一項，就放他們的像素頭像（最多三個）。需要使用者處理時，換成一個 primary 的 mono 動詞。
- **狀態標籤（pill）**：細框、mono 小字，放在頂端，說明「這個東西現在在哪裡、用什麼」（模型、在哪台電腦，前面一個綠點表示連著）。點一下切換。
- **行內動詞**：一排 primary 的 mono 字（「壓縮　新的上下文　複製回答」），放在它作用的內容底下。按下後原地換成結果（「已壓縮」），不跳提示。
- **展開的細節**：點一列就在下面展開，只寫列上沒有的東西，最後一行是動詞（立即執行、暫停、刪除，刪除用 error 色）。
- **識別方塊**：Bot 用像素頭像；服務用品牌圖示（npm 的 `simple-icons`，掛在 `src/agent/mcp-catalog.ts` 的條目上），放在白底方塊；沒有圖示的用字母方塊。
- **新增列（`.list-add`）**：虛線分隔，mono 的「＋ 新增 …」，接在列表尾。
- **按鈕（`.btn`）**：mono 字、細框、方括號 `[ 連接 ]`。只用在表單、底部抽屜和設定頁，不放進列表列，也不放進側邊欄。
- **開關（`.switch`）**：只用在「一列就是一個設定」的地方（設定頁、工具清單）。內容列表裡不放。
- **詳情**：從底部拉起的抽屜（`Sheet`），上緣圓角、頂端一支手把，標題 19px 粗體，上面是細節，最底下是危險的動作。
- **標題列**：浮在對話上的兩顆膠囊，左邊是 Bot（頭像開 Bot 列表，名字和模型開模型選單，旁邊一圈是用掉的上下文），右邊是工具（瀏覽器、資料夾、⋯）。Bot 在做事時，名字後面閃一個黃色游標。對話從膠囊的中線往上淡出到通知列。膠囊是半透明的底色，不模糊：毛玻璃在 S24 上串流時捲動的超時幀從 12% 升到 19%（`docs/architecture.md`）。
- **工具方塊**：Bot 的工具一格一格排成三欄，依「手機、網路與資料、帳號、電腦、連接的服務」分組，開著的是 primary 底。每一組都要有圖示（`lucide-react` 的細線圖示，帳號用品牌標誌）。
- **確認框**：iOS 的樣子。270px 寬、置中，標題粗體，下面一句說明；底部兩格按鈕佔滿整排、用細線隔開，左邊「取消」，右邊是動作（粗體，危險的用 error 色）。動作只寫一個動詞（開始、刪除、清空），標題已經說了是什麼事。
- **整頁**（設定、記憶）：照下面的〈空間〉，疊在打開它的地方上面，返回時回到那個側欄。

要淘汰的舊寫法（改到時換掉）：把列表包起來的 `.group`、`.menu` 框；列表列裡的 `[ 按鈕 ]` 和開關；「標題＋框＋框裡的分組標題」三層疊在一起的區塊。

## Do's and Don'ts

- Do 先決定每樣東西屬於「一眼看到、點開才看到、設定時才需要」的哪一層；Don't 把三層攤在同一個平面上。
- Do 把列表直接放在背景上；Don't 用 `.group`、`.menu` 框或卡片包住它，也不要塞進舊的框裡：框的標題加上列表自己的分組，會變成兩層標題。
- Do 讓列表只負責展示「有什麼」；Don't 在每一列放開關或 `[ 移除 ]`，它在第一眼不重要，又會擠掉名稱。
- Do 用記號表示狀態（閃爍的方塊、圖示、變淡、✓ ✕）；Don't 寫成句子（「已連線 · 23 個工具」「上次 … 手動執行」）。
- Do 同一件事只說一次：列上有了時間，展開的細節就只補「每天」「平日」；Don't 在列上、說明、細節各寫一次 21:30。
- Do 說明這一項是做什麼的；Don't 用統計數字當說明，數量收進詳情。
- Do 把移除這類動作放在最底下，用 error 色；Don't 讓它和日常操作並排。
- Do 讓一個設定只有一個地方能改（Bot 能用哪些服務，只在 Bot 面板改）；Don't 在兩個畫面各做一份開關。
- Do 用 `simple-icons` 這類現成套件取得品牌圖示；Don't 自己抓 favicon 或手畫。
- Do 讓使用者回得去：從側欄打開的頁面，返回後還在側欄；Don't 先把側欄收起來再蓋一整頁，回來時又落在別的地方。
- Do 一層就給完整的資訊（點開上下文，細目和用量一起出現）；Don't 在展開的內容裡再藏一層折疊。
- Do 用元素自己的邊框或底色表示正在輸入（輸入框的邊框變 accent）；Don't 讓任何地方出現焦點框：按過的按鈕、返回鍵、關掉的抽屜外面多一圈框，一看就是網頁而不是 App。

## 實作流程

1. 新畫面或大改動，先做一頁 HTML 畫面稿（放在 tailnet 上，手機直接開），用真實的內容，讓使用者選。
2. 實作時連外面的容器一起換掉，不要只換裡面的列。
3. 給使用者看之前，在手機上截圖，跟畫面稿並排比對：容器、層級、控制項大小、窄的地方有沒有被擠壞、有沒有重複的字。對不上就先修。
