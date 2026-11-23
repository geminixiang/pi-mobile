# pi-mobile-ui：把 UI 拆成 monorepo 裡的一個 package

狀態：使用者 2026-11-23 同意方向（選 A）。實作在分支 `ui-package`：第 0–4 步完成，到里程碑 A（workspaces 和檢查規則；`pi-mobile-base`；`UiPlatform`；`src/ui` 和 `ui.css` 搬進 `pi-mobile-ui`；tokens、元素預設、共用外觀和字型移出 `styles.css`）。第 5 步起還沒做。

## 問題

使用者要把 pi-mobile 的 UI 獨立成 `pi-mobile-ui`，照 [assistant-ui](https://github.com/assistant-ui/assistant-ui)（MIT）的形狀自己做：一份狀態介面、沒有樣式的組合元件（`Thread.Root`、`Composer.Input`…）、再加上有樣式的成品元件。我們學它的分層，不用它的程式，也不學它的狀態模型。

形狀不明顯的地方：

- `src/ui/`（28 個檔案）已經是最底層，但 15 個資料夾直接用路徑引用它的內部檔案。
- 對話三件（`Chat`、`Message`、`Composer`，共 1,370 行）和 pi-durable 綁在一起。
- 側欄的位置分成三處：JS 在 `src/app/SidePanel.tsx`，手勢數學在 `src/ui/sideGesture.ts`，CSS 在 `styles.css`。
- `App.tsx` 用 `document.querySelector(".composer …")` 直接碰輸入框。
- 效能和裝置腳本靠 class 名稱和元素結構找畫面（`.composer textarea`、`.transcript`），而且 `.transcript > :nth-last-child(n + 6)` 依賴「訊息是 transcript 的直接子元素」。
- Capacitor 的 `android/`、`ios/` 用相對根目錄的 `node_modules` 路徑。

以上數字是設計 agent 在 `fb6a0f0` 用 `git grep`、`wc` 跑出來的；三份設計和一份裁決的原稿在 `.pi/design/`（不進 git）。

## 用起來的樣子

```tsx
// src/app/chat/Chat.tsx：pi 的推導（工具狀態、步驟、回覆、問題卡）留在這裡
<Thread.Root className="chat" viewport={viewport}>
	<Thread.Viewport className="transcript">
		{rows.map((entry) => <EntryView key={String(entry.id)} entry={entry} … />)}
		{tail ? <Thread.Tail className="answer"><StreamingText … /></Thread.Tail> : null}
	</Thread.Viewport>
	<Composer.Root thread={thread} draft={draft} className="composer">
		<JobsStrip />
		<Composer.Queue className="queue">{(item) => <QueueRow item={item} />}</Composer.Queue>
		<Composer.Input placeholder={busy ? "插話，或排一個下一步" : "問 pi"} />
		<Composer.Send … /><Composer.Stop … />
	</Composer.Root>
</Thread.Root>
```

package 收子元件和顯示用的 props；它不認得 `EntryRecord`、`ConversationView` 或任何 pi 的型別。

## 形狀

```
pi-mobile/                 根目錄仍是 App；"workspaces": ["packages/*"]
  src/ test/ android/ ios/ index.html vite.config.ts capacitor.config.ts   都不動
  packages/
    pi-mobile-base/        time.ts、log.ts、promise.ts：沒有 React，核心和 UI 都用
    pi-mobile-ui/          private、只有原始碼、不編譯；exports 指向 ./src
      platform/            UiPlatform 介面、按壓、震動、返回、回到前景、剪貼簿
      store/               Source、cell、useSubscribed、useLoaded
      shell/               SideSwipe、SidePanel、PageStack、Sheet、Dialog 和它們的 CSS
      thread/ message/ composer/ thread-list/   組合元件
      elements/            DESIGN.md 的外觀：回答、提問泡泡、工作行、列、按鈕、圖示
      styles/              tokens.css 和共用外觀
```

- **訊息的資料形狀屬於 App（選 A）。** package 管框架（viewport、黏在底部、輸入框、串流文字），App 用現有的 memo（`sameEntryView`）把 pi 的紀錄畫成列。理由：一則訊息顯示什麼常要看後面的紀錄（工具結果、步驟合併、重試、問題卡、網頁卡），還要表單和輸入框的狀態；`threadOf(view)` 畫不出完整畫面。
- **介面只放元件真正要知道的：** `ThreadSource`（busy、queue、send、stop、withdraw）、`Viewport`（stick、toBottom、jumpTo）、`Draft`、`UiPlatform`。
  - `UiPlatform` 做出來是 `haptic(kind)`、`onBack(taken)`、`onResume(run)`、`copy(text)`、`pasted()`，App 用 `installPlatform` 裝上。和草稿只差一處：`onBack` 收到的函式要回報「有沒有哪一層接手」，因為沒有任何一層開著時要把 App 收到背景，那是原生的事，留在 App 這邊。
- **每個組合元件只渲染今天就有的那一個元素：** 不加包裝 div，不用 Slot，class 由呼叫端給。
- **列底下不讀串流時會變的 context 或 store。**
- **不准 effect hook。** 計時器只有 `pi-mobile-base/time.ts` 一個擁有者。
- **動畫跟著 `Source` 走。** 寫入 `--side-*`、`--stack` 的 JS 和讀它的 CSS 放同一個資料夾。

## 候選與取捨

- **A（採用）**：訊息是 App 的物件，以 props 和子元件傳入。
- **B**：package 擁有封閉的訊息模型（`Thread<C>`、`Part<C>`），App 寫一個純函式轉換。好處是能用假資料畫出整段對話；代價是約 250–400 行的轉換，並且要保住「沒變的訊息仍是同一個物件」，否則串流時每批都重畫歷史（S24 量過：整份工具狀態失效，一次重畫 230 ms）。assistant-ui 自己的 pi 轉接器為此寫了 920 行。
- **整個 App 搬到 `apps/mobile`**：會動到 Xcode 路徑、腳本、CI，使用者什麼都得不到，不做。
- **assistant-ui 的狀態模型**（每則訊息一個 provider、selector 訂閱、Slot、effect）：在列的路徑上加訂閱和包裝，違反我們量過的效能規則，不採用。

## 接受的代價

- 一則完整的對話仍要 App 組出來；package 不能只拿資料重播。
- 多兩個 package 和一份公開入口清單（由檢查規則確保不漏）。
- `btn`、`menu-text` 這類共用 class 名稱還是字串；之後改到那個畫面時，再一個個換成元件。

## 已決定

| 問題 | 決定 |
|---|---|
| 訊息的資料形狀 | A（使用者 2026-11-23） |
| 發布到 npm | 不發布：private、只有原始碼 |
| 範圍 | 元件庫和對話（里程碑 A、B）；設定、工作台、右側欄、功能卡片留在 App |
| 計時器 | 另開 `pi-mobile-base` |
| 輸入框草稿搬出 `Chat` | 允許，第 8 步，有 S24 量測把關 |
| CSS | 維持一個 `app` layer，class 名稱一個都不改 |
| 套件管理 | 維持 npm workspaces，不換 pnpm（使用者 2026-11-24）。pnpm 的嚴格依賴已由檢查規則做到；換的代價是 Capacitor 原生專案的 `node_modules` 路徑、腳本和 CI 裡 17 處 `npm`/`npx`。package 變多、需要只跑某一個 package，或安裝拖慢開發時再評估，先在分支上編譯、`cap sync`、上 S24 確認 |

**什麼時候改做 B：** 出現第二個使用者，需要拿資料直接畫出完整對話時，例如用假資料重播對話的檢視器。改做前要先過兩關：在 Node 重播真實的對話變化時，舊訊息的物件都不變；S24 五個場景各 5 次，不能變慢。

## 步驟

每一步是一個 commit，`npm run check` 要通過、class 和元素結構不變，並在同一個 commit 更新它影響到的文件（feature-map、architecture.md § 分層、css skill、effects.md）。

| # | 內容 | 量測 |
|---|---|---|
| 0 | workspaces；檢查規則擴大到 `packages/`：`inSource`、`LAYER_OF` 加上 package、新規則（不准往上引用、不准引用 Capacitor 和 pi、App 只能從公開入口引用）。每條新規則都先證明會失敗 | 無 |
| 1 | `time.ts`、`log.ts`、`promise.ts` 搬到 `pi-mobile-base` | 無 |
| 2 | `UiPlatform`：震動、返回、回到前景、剪貼簿不再直接碰 `native.ts` 和 `@capacitor/app` | S24 和 iPhone 試返回鍵、回到前景 |
| 3 | `src/ui` 和 `ui.css` 搬進 package | 截圖；`panel`、`stream` × 3 當之後的基準 |
| 4 | tokens、共用外觀、字型移出 `styles.css`。**里程碑 A** | 比對算出來的樣式，亮色和暗色 |
| 5 | 按壓、`SidePanel`、`PageStack`、`@property` | 全部場景 × 5；S24 和 iPhone 試側欄 |
| 6 | `Thread.Root/Viewport/Tail`、`useViewport` | 全部場景 × 5；節點數相同 |
| 7 | 串流文字、Markdown、訊息外觀 | 全部場景 × 5 |
| 8 | `Composer.*`、草稿、拿掉 `App.tsx` 的兩處 DOM 操作。**里程碑 B** | `typing` 加全部場景 × 5 |
| 9 | 選做：`ThreadList` | `panel` × 3 |

## 做到里程碑 A 時定下來的細節

草稿沒寫到、實作時要選的地方。每一項都不改上面的形狀；不同意的話，改起來都是搬幾個檔案。

- **公開入口**：一個資料夾一個 `index.ts`，只列 App 真的用到的名稱，另外有 `pi-mobile-ui/gesture`（手勢的數學是純 `.ts`，Node 的測試讀得了）、`pi-mobile-ui/fonts` 和 `pi-mobile-ui/styles.css`。「列了卻沒人用」和「App 沒引到的 package 檔案」都由檢查擋下。
- **測試**留在根目錄的 `test/`，可以用相對路徑引 package 裡不公開的檔案（`test/sources.ts`）；其他程式碼只能用名稱。
- **`src/ui` 有兩個檔案沒有進 package**：`beside.ts`（工作台正在看哪個檔案）和 `csp.ts`（HTML 預覽的 CSP）是 App 的接線，不是 UI，搬到 `src/`。`openFile.ts` 整個進了 `message/`，因為 markdown 要讀它的 context；它的兩個路徑小工具跟著進去，第 7 步把 context 改成 prop 時一起搬走。
- **相依**：只有 package 用的（Base UI、pele、remark 的三個外掛、兩個字型）從根目錄的 `package.json` 移到 package 的；React 和 `simple-icons` 是 peer，版本和根目錄一樣，不一樣時 `npm install` 會擋。
- **樣式的順序**：`index.css` 第一行是 package 的入口，裡面依序是 `tokens`、`base`、`looks`、`message`、`shell`、`elements`，接著才是外殼的 `styles.css`。外殼的規則因此排到共用外觀和元件的後面（1061 個 selector 一個不多一個不少；順序對調、特異性相同、又設到同一個屬性的 932 對，都要同一個元素同時符合兩邊才有差，逐對查過原始碼沒有這種元素；瀏覽器裡 19 個畫面、亮暗、窄寬、按下的算出來的樣式也一樣）。
- **哪些規則留在 `styles.css`**：每個 selector 都點到一個只有 `src/app/` 自己的元件用的 class（`.app`、`.bar-pill`、`.side-*`、`.drawer`、`.frame-*`、`.skeleton-*`）才留下；其餘 119 條是「好幾個資料夾共用」，進 `looks.css`。所以 `looks.css` 裡有只有 App 的資料夾在用的名稱（`.viewer-*`、`.ws-*`、`.queue`、`.drawer-item.current`）：它們是字串形式的共用詞彙，照〈接受的代價〉之後再換成元件。
- **還沒試的**：第 2 步的返回鍵和回到前景要在 S24 和 iPhone 上試。

### S24 的基準（2026-11-24，`panel`、`stream` × 3）

同一支 S24、同一個晚上、充電中（`run.ts` 每次都提醒充電會比較熱；後兩輪開始前熱狀態是 1，等它降溫才量）。每一輪都重裝那一版、重開 pi、fixture 先拆再建，節點數每一次都相同（`panel` 3263；`stream` 3749、3992、4235）。順序是 main、第 3 步、第 4 步、再量一次 main；main 是手機上原本的 `3f99d28`，和 `84c64e4` 只差排程的修正，沒有動到畫面。括號裡是三次的值。

| 場景 | 指標 | main | 第 3 步 | 第 4 步 | main 再一次 |
|---|---|---|---|---|---|
| panel | gfx 掉幀 % | 2.9（2.6/2.9/3.2） | 2.9（2.9/2.9/4.1） | 2.6（2.3/2.6/2.6） | 3.2（3.7/2.3/3.2） |
| panel | gfx p99 ms | 23 | 27 | 22 | 21 |
| panel | rAF 超時 % | 0.4 | 0.5 | 0.5 | 0.5 |
| stream | gfx 掉幀 % | 1.8（1.7/1.8/1.8） | 2.9（2.8/3.1/2.9） | 2.5（2.2/2.5/2.9） | 2.5（2.6/2.4/2.5） |
| stream | gfx 超過 12 ms 的幀 | 14（14/26/12） | 32（56/32/19） | 53（53/28/67） | 24（25/24/18） |
| stream | gfx p99 ms | 10（10/10/10） | 12（14/12/11） | 13（13/11/14） | 10（11/10/10） |
| stream | rAF 超時 % | 0.2 | 0.2 | 0.3 | 0.2 |

怎麼讀：

- 同一版 main 兩次量，`stream` 的 gfx 掉幀就從 1.8 % 變成 2.5 %。所以隔了一段時間、重裝過的兩輪之間，0.7 個百分點是量測本身的浮動，不能拿來比版本。第 4 步（2.5 %）和 main 再一次（2.5 %）一樣。
- `stream` 的尾端（超過 12 ms 的幀、p99）在兩個新版本上都比兩次 main 高一點：每輪約 4,600 幀裡 32 和 53 幀，對 14 和 24 幀；p99 是 12–13 ms 對 10 ms。每邊只有 3 次，這個差距分不出是程式碼還是條件，沒有排除。頁面主執行緒的數字（rAF 超時、長幀阻塞 0 ms）四輪都一樣。
- 之後的步驟不要直接拿這張表當「之前」：在同一輪裡先量前一版、再量新版（拔掉充電線），第 5 步起本來就要全部場景各 5 次，那時交替量兩版，尾端的差距是真是假才看得出來。

原始結果在 `~/pi-tasks/shots/ui-package/perf/`。

## 對未來的影響

- **移除：**
  - `src/ui` 的內部檔案可以被任意引用；
  - 側欄位置由三處分管；
  - `App.tsx` 直接碰輸入框的 DOM；
  - 「底層不認得上層」只寫在文件裡，改成編譯錯誤。
- **新增：** 一份公開入口清單、兩個 package。
- **留給以後：** B、`Sheet` 換掉 Base UI 的 Drawer、共用 class 換成元件。

## 第一步

讓檢查規則看得到 `packages/`，package 先保持空的。
