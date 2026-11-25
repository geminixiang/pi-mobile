# pi-mobile-ui：把 UI 拆成 monorepo 裡的一個 package

狀態：使用者 2026-11-23 同意方向（選 A）。第 0–4 步完成並合併進 main（`bd6c2c1`），到里程碑 A（workspaces 和檢查規則；`pi-mobile-base`；`UiPlatform`；`src/ui` 和 `ui.css` 搬進 `pi-mobile-ui`；tokens、元素預設、共用外觀和字型移出 `styles.css`）。第 5 步起還沒做，等 iPhone 一起驗手勢和捲動。2026-11-24 在分支 `solid-trial` 試過把 UI 換成 Solid 2.0：S24 上量不出差別（打字快 1 ms，來自結構而不是 Solid），所以繼續用 React；報告在那個分支的 `docs/research/solid-trial.md`。

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

## 剩下的步驟（第 5–9 步）

第 0–4 步已完成並合併進 `main`（`bd6c2c1`），workspace 檢查規則與檔案位置見 `docs/architecture.md` § 分層。每一步是一個 commit，`npm run check` 通過、class 與元素結構不變：

| # | 內容 | 量測 |
|---|---|---|
| 5 | 按壓、`SidePanel`、`PageStack`、`@property` | 全部場景 × 5；S24 和 iPhone 試側欄 |
| 6 | `Thread.Root/Viewport/Tail`、`useViewport` | 全部場景 × 5；節點數相同 |
| 7 | 串流文字、Markdown、訊息外觀（將 `openFile` context 改 prop 並移走兩個路徑小工具） | 全部場景 × 5 |
| 8 | `Composer.*`、草稿、拿掉 `App.tsx` 的兩處 DOM 操作。**里程碑 B** | `typing` 加全部場景 × 5 |
| 9 | 選做：`ThreadList` | `panel` × 3 |

## 里程碑 A 留下的驗證事項

- 第 2 步的返回鍵與回到前景待 S24 與 iPhone 實機驗證。
- 2026-11-24 S24 粗量（充電中、`panel`/`stream` × 3）看到跨輪浮動達 0.7 個百分點（`stream` main 1.8% vs 2.5%），且新版本 `stream` 尾端 p99 為 12–13 ms 對 main 10 ms、超過 12 ms 的幀 32–53 對 14–24，樣本少無法判定真偽。第 5 步起拔掉充電線、在同一輪內交替量前後版（全部場景 × 5）確認。

## 留給以後

B、`Sheet` 換掉 Base UI 的 Drawer、`looks.css` 裡的共用 class 換成元件。
