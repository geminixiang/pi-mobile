# 依賴已經有的，我們有沒有重做一份

2026-11-16。範圍是 pi-mobile `52b0b31` 的 `src/`，對照 `node_modules` 裡實際安裝的版本：`@earendil-works/chord`、`pi-durable`、`pi-env`、`pi-ai`、`pi-mcp`、`pi-codemode`、`pi-schema`、`pi-telemetry`（都是 1.5.2）、`just-bash` 3.6.0、`just-git` 1.10.0、`typebox` 1.3.27、`buffer` 6.0.3、`path-browserify` 1.0.1、`fflate` 0.8.3。pi 的 main 分支（`v1.5.2-246-g7ce13c086`，比 1.5.2 多 246 個 commit）只拿來回答「升級後會不會有」，文中寫成 `pi-main/packages/…`；npm 的 1.5.2 沒有的東西都會註明。

沒有改任何程式，沒有提交。`host/` 的 Go 依賴（`coder/websocket`、`purego`、`dbus`、`xgb`、`x/image`、`x/sys`，`host/go.mod`）跟 pi 的套件沒有重疊，沒有往下查。

## 方法與證據標記

1. 列出 `src/` 自己的工具函式和機制：時間、promise、JSON 與驗證、id、雜湊、編碼、截斷、log、重試、取消、佇列、訂閱、IndexedDB、背景工作、斷線續傳、MCP、圖片、檔案環境。
2. 每一項到依賴的 `package.json` `exports` 和 `dist/*.d.ts` 找對應的匯出，再看它能不能在 WebView 載入：從那個 `dist` 檔沿著 import 走完，看有沒有 `node:*`、`child_process`、`cross-spawn`。
3. 行為逐條比：邊界情況、錯誤是丟出來還是回傳。

證據標記跟 [foundation-audit.md](foundation-audit.md) 一樣：

- **〔跑過〕**：寫了 Node 腳本對著 `node_modules`（必要時加上 `src/` 的真實檔案）執行，離線。腳本放在暫存資料夾，沒有進 repo；每一支做了什麼寫在文末「跑過的腳本」。
- **〔讀碼〕**：打開檔案讀過，附 `路徑:行`。
- **〔推測〕**：沒有驗證。

沒有在手機上跑任何東西；「WebView 可載入」是從 import 圖判斷的〔跑過：import 圖〕，不是在 WebView 裡實測。

路徑的寫法：`pi-ai/…` 是 `node_modules/@earendil-works/pi-ai/…` 的簡寫，`chord/…`、`pi-durable/…`、`pi-env/…`、`pi-mcp/…`、`pi-schema/…` 同理。

## 結論

- **真的重做、而且值得換的有四處**：憑證儲存（換掉會順便修掉一個真的 bug）、邊界驗證的引擎、工具輸出的截斷、文件變更的通知。另外四處很小，順手就能換。
- **一處要等升級**：等待使用者回答的工具（`Forms`），main 的 signals 和 park 涵蓋這個情境。
- **其餘看起來像重做的，都有不能換的具體原因**：原版只能在 Node 跑、沒有從 `exports` 匯出、寫死 `globalThis.fetch`、或是換了提示會變貴。這些列在「刻意保留」，免得之後有人照著「依賴優先」把它們「修掉」。
- pi-mobile 對 chord 的用法（`Context`、`BACKGROUND_CONTEXT`、`isJsonValue`、`utf8ByteLength`）沒有重做任何東西。

## 排名表

排序依「換掉的好處 × 把握」。行數是我們這邊會動到的程式；「少什麼」是換掉後消失的東西。

| # | 我們的程式 | 依賴的匯出 | WebView 可載入 | 行為差異 | 換掉後少什麼 | 風險 | 結論 |
|---|---|---|---|---|---|---|---|
| 1 | `memoryCredentials`，`src/agent/credentials.ts:7-33`（27 行） | `InMemoryCredentialStore`，`@earendil-works/pi-ai`（`pi-ai/dist/auth/credential-store.js:7-50`） | 可以：只 import `utils/abort.js`，而且 `createModels()` 沒給 `credentials` 時本來就用它（`pi-ai/dist/models.js:47`），已經在 bundle 裡 | `modify` 的 `fn` 回 `undefined`：合約是「不動」，我們是**刪掉**。依賴的佇列是每個 provider 一條，我們是全部共用一條。依賴沒有建構時的初值，也沒有「OAuth 換新時存回設定」的通知 | 約 15 行、`serially` 的一個用途；一個會讓 ChatGPT 登入在執行中消失的 bug；「合約實作兩份」 | 低：要補初值和存回設定的那一層，三個合約測試的空憑證可以直接用預設 | **replace** |
| 2 | 邊界驗證的引擎：`src/parse.ts:1-12、30-34、47-55、79`；`defineAppTool` 的再檢查 `src/agent/tools/common.ts:115-118` 和 `numbered`（`:38-42`）；另外 8 處直接呼叫 `Value.Check` | `compile(schema, { coerce })` 的 `check`／`errors`／`validate`／`parse`，`@earendil-works/pi-schema`（`pi-schema/dist/validator.d.ts`） | 可以：沒有任何 node import，也不用 eval。pi-ai 檢查工具參數時已經用它（`pi-durable/dist/harness/tool.js:5`、`pi-ai/dist/utils/validation.js:12`），已經在 bundle 裡。要在 `package.json` 補成直接依賴 | 對 TypeBox 的 schema，`check` 的結果抽樣 280 組全部相同。錯誤訊息的用字不同（`must be string` → `expected string, got integer`），路徑同樣是 JSON Pointer。`coerce` 會做我們 `numbered` 和「單一值包成陣列」做的事，還多做 `"true"`→`true`、數字→字串 | bundle 裡的第二套驗證器（`typebox/value`、`compile`、`system`：單獨打包 124 KB，gzip 33 KB）；`numbered` 5 行；`Locale.Set` 那段；「同一份 schema 驗兩次、規則不一樣」 | 中：模型看到的錯誤用字是對著 Qwen3.6 量過的（`docs/tools.md:413`），要照原樣對回去並重跑那 10 題 | **replace**，分兩步；`Type` 建構子照舊 |
| 3 | `truncated`，`src/agent/tools/common.ts:172-176`，4 個呼叫點（`github.ts:18`、`cloud.ts:20`、`web.ts:233`、`computer-agents/tool.ts:95`） | Harness 對每個工具結果做的 `boundContent`，上限由 `ToolRegistration.outputLimits` 決定（`pi-durable/dist/harness/types.d.ts:312-316`、`tool.js:218-223、581-584`），底下是 `chord/output` 的 `boundOutput` | 已經在跑：每個工具結果都會過這一關 | 我們切在 40,000 **字元**並在最後附一句「怎麼縮小範圍」；Harness 接著再切一次，保留開頭 50 KB、2,000 行。中文多或行數多時，我們附的那句被 Harness 切掉 | 5 行加 4 個呼叫點；「同一段輸出切兩次，第二次切掉第一次的提示」 | 低到中：提示改放哪裡要決定（工具說明，或用 `api.diagnostic`） | **replace** |
| 4 | 文件變了要通知畫面：`Memories`（`src/agent/memory.ts:31、42-51、62、100`）、`Skills`（`src/skills/skills.ts:58、68-77、84、134`），和把 `changed` 一路傳進工具的接線（`src/agent/catalog.ts:52-53`、`src/agent/runtime.ts:239-240`） | `Harness.watchDoc(token, …, context)`（`pi-durable/dist/types.d.ts:1009-1014`），回傳 chord 的 `WatchHandle` | 可以：`pi-durable` 的根匯出沒有 node import | `watchDoc` 對每個 commit 都通知，不管是誰寫的；但文件**還不存在時回 `undefined`**，要有人先建立。我們的做法是每個寫入的人自己記得呼叫 `changed()`，再重讀一次 snapshot | 「靠人記得呼叫」的通知路徑（紅旗：手動同步）、catalog 的兩個相依、每次變更多讀一次 | 中：要決定誰建立文件（建 Bot 時、或開 runtime 時），行數不會少多少 | **replace**，先決定建立時機 |
| 5 | `bytesOf` 的字串分支，`src/agent/traffic.ts:12-16` | `utf8ByteLength`，`@earendil-works/chord/output`（`chord/dist/output.js:241`），`phone-env.ts:129` 已經在用 | 可以 | 位元組數相同（2,013 個樣本，含落單的 surrogate，兩條路徑都試了）；我們每次都 `encode` 出一個陣列再丟掉，串流的每個 delta 一次（`src/agent/network.ts:139`） | 一個 `TextEncoder`、每個 delta 一次配置 | 低 | **replace**（小） |
| 6 | MCP 工具的參數 schema，`src/agent/mcp.ts:310` | `normalizeMcpInputSchema`，`@earendil-works/pi-mcp`（`pi-mcp/dist/input-schema.js:6-12`） | 可以：這個檔沒有 import | 伺服器給了不是 `object` 的 `type` 時，我們硬改成 `object`，依賴保留原值（之後由驗證擋下） | 1 行；跟 pi 的 coding agent 同一個規則 | 低 | **replace**（小） |
| 7 | `normalizePath`、`resolvePath`，`src/agent/files/protocol.ts:3-15`（13 行） | `resolve`，`path-browserify`（已是依賴，`src/shims/node-path.ts:1`） | 可以；但 base 不是絕對路徑時它會讀 `process.cwd()`（`path-browserify/index.js:124`），WebView 沒有 `process` | 110 組輸入結果相同（`normalizePath(p)` 就是 `resolve("/", p)`） | 約 10 行 | 低；shell worker 的 bundle 會多帶一份 path-browserify | **replace**（小，可做可不做） |
| 8 | `sleep`，`src/promise.ts:49-51`；`src/agent/oauth.ts:4` 另外 import 了 pi-ai 的 | `sleep(ms, signal)`，`@earendil-works/pi-ai/utils/sleep`（`pi-ai/dist/utils/sleep.js`） | 可以：沒有 import | 依賴的一定要給 `signal`，中止時 reject；我們的不能中止 | 「等待有兩個來源」（`test/code-rules.ts:166` 說等待只用 `src/promise.ts` 的） | 低 | **replace**（小）：`src/promise.ts` 當唯一入口，有 `signal` 時轉給 pi-ai 的 |
| 9 | 等使用者回答的工具：`Forms`，`src/interaction/forms.ts`（111 行，等待的部分在 `:29、36、46-74`）；同類的還有 `src/triggers/watch.ts` 和 `src/jobs/bash.ts:53-66` 的「先回、之後叫醒」 | signals 和 tool park：`defineSignal`、`harness.signal()`、`execute()` 回 `{ sleep: { signals } }`。**只在 main**（`pi-main/packages/durable/src/signals.ts`、`harness/parks.ts`；`CHANGELOG.md:16-23` 在 `[Unreleased]` 底下）；1.5.2 的 `dist/index.d.ts` 沒有這些名字 | main 的沒有驗證 | park 的呼叫不佔執行、狀態存在 task 裡，app 被殺掉後還在；我們的等待是記憶體裡的 promise | 兩個已知問題的根源（`foundation-audit.md:29` 第 2 項、`interaction-cards.md:294`） | 高：要升級，main 有破壞性變更（`CHANGELOG.md:5`） | **replace after upgrade**，先評估 |
| 10 | 無狀態的 MCP 呼叫，`src/agent/mcp-stateless.ts`（145 行） | 沒有：1.5.2 的 `LATEST_PROTOCOL_VERSION` 是 `2025-11-25`（`pi-mcp/dist/protocol/types.js:1`），main 也還沒有 `server/discover`、`input_required` | — | — | 整個檔案 | — | **keep**，上游支援 2026-07-28 就換（`docs/tools.md:363` 已經這樣寫） |
| 11 | 電腦上的 stdio MCP 走 `/exec`：`hostStdio`，`src/computer/commands.ts:158-183` | `openProcess(connection, options)`，`@earendil-works/pi-env`（`pi-env/dist/process.d.ts`）；pi-mcp 的 `PipeTransport` 舉的例子就是它（`pi-mcp/CHANGELOG.md:9`、`pi-env/CHANGELOG.md:9`，都是 1.5.1） | 要先把它加進 `src/shims/pi-env.ts` | 要有一條 pi-env 連線才能開；`/exec` 不用 | 不會少：容器、背景工作、`HostCommands.run` 還是要 `/exec` | — | **keep** |
| 12 | MCP 登入，`src/agent/mcp.ts:241-293`（53 行） | `startMcpSignIn`、`completeMcpSignIn`，`@earendil-works/pi-mcp/oauth`（`pi-mcp/dist/oauth/sign-in.js`） | 載得進來，但用不了 | 它對授權伺服器的請求寫死 `timedFetch()`，也就是 `globalThis.fetch`（`sign-in.js:162`、`client-settings.js:80`），選項裡沒有 `fetch`；WebView 的 fetch 會被 CORS 擋，我們要走 `mcpFetch` | 約 40 行 | — | **keep**，可向上游要 `fetch` 選項 |
| 13 | MCP 工具和服務的命名，`src/agent/mcp.ts:30-42、82` | `createMcpToolName`、`mcpNamespace`，`@earendil-works/pi-mcp`（`pi-mcp/dist/naming.js`） | 不行：`naming.js:6` import `node:crypto` 的 `createHash`，我們的 shim 一呼叫就丟錯（`src/shims/node-crypto.ts:11-13`） | 名稱格式不同（`mcp__<server>__<tool>` 對 `<id>_<tool>`） | 約 14 行 | 改工具名稱是產品變更（AGENTS.md） | **keep** |
| 14 | ChatGPT 登入，`src/agent/chatgpt.ts:24-107`（84 行） | `openaiChatGPTOAuth`，`pi-ai/dist/auth/oauth/openai-chatgpt.js` | 不行：import `node:crypto`、`node:http`（`:7-8`），換 token 用全域 `fetch`（`:111`）；而且 `./auth/*` 不在 `exports` 裡 | 我們是照它移植的：網址、client id、port、scope、提前 3 分鐘過期都相同。差別是 agent 名稱，以及 pi-ai 換授權碼時要求回應裡有 `id_token`（`:167-169`），我們當成選填（`chatgpt.ts:29`） | 約 80 行 | — | **keep** |
| 15 | 斷線續傳，`src/computer/resumable-link.ts`（153 行）、`resumable-socket.ts`（170 行） | `keepConnected`，`@earendil-works/chord`（`chord/dist/surfaces/connection.js`） | 可以：這個檔沒有 import | 它只管重連，不補送；時間都是寫死的常數（`:8-18`），不能照 `host/protocol.json` 設定 | — | — | **keep** |
| 16 | codemode 的提示段落和 `signatureOf`，`src/agent/codemode.ts:53-60、159-176` | `createCodemodeExtension` 的 `codemode` 段落（`pi-durable/dist/codemode/describe.d.ts:37`） | 可以 | 依賴列出完整的 TypeScript 宣告，預設 3,000 token；我們一個工具一個簽名 | 約 26 行 | 提示變貴約 5 倍 | **keep** |
| 17 | 假裝成子程序的連線：`src/agent/sandbox/phone-connection.ts:55-197`（143 行）、`daemon-state.ts:58-103`、`src/shims/node-*.ts`、`vite-plugins/pi-env.ts` | 沒有：`Connection` 只接受「啟動 daemon 的指令」（`pi-env/dist/connection.d.ts`），main 也一樣 | — | — | 約 300 行 | — | **keep**，可向上游要 transport 選項 |
| 18 | base64 和 hex，`src/encoding.ts:1-28` | `Buffer`，`buffer`（已是依賴） | 可以 | 6.0.3 沒有 `base64url`（`src/shims/buffer-global.ts:3-7` 就是在補它）；解碼比我們慢 6 倍，編碼快 2 倍 | 約 20 行 | — | **keep** |
| 19 | token 估算：`estimateTokens`，`src/agent/attachments.ts:59-62`；`charsOf`，`src/agent/context-shape.ts:17-28` | `estimateTextTokens`、`estimateMessageTokens`，`@earendil-works/pi-ai/utils/estimate` | 可以 | 依賴一律 3.5 字元一個 token，100 個漢字估成 29；我們估 100 | — | — | **keep** |
| 20 | 送出前縮圖，`src/agent/attachments.ts:34-39`、`src/app/Composer.tsx:35-41` | `createPhotonImages`，`@earendil-works/pi-durable/images` | 可以 | 要多帶一個 1.9 MB 的 wasm，在呼叫的執行緒上跑 | — | — | **keep** |
| 21 | 用 `typebox` 的 `Type` 寫 schema（82 個檔案） | pi-schema 的建構子 `obj`、`str`、`opt`… | 可以 | `obj` 預設是封閉的（`pi-schema/README.md:62`），TypeBox 的 `Type.Object` 是開放的 | 一個依賴 | 高：505 個物件 schema 的意思會變 | **keep** |

## 值得動的，逐項說明

### 1. 憑證儲存：換成 `InMemoryCredentialStore`

**合約**〔讀碼〕：`CredentialStore.modify` 的 `fn` 回傳新的憑證，「or undefined to leave the entry unchanged」，並以寫入後的憑證 resolve（`pi-ai/dist/auth/types.d.ts:68-76`）。pi-ai 自己的實作照做（`credential-store.js:40-42`）。

**我們的實作**〔讀碼〕：`fn` 回 `undefined` 就 `store.delete(providerId)`，並回傳 `undefined`（`src/agent/credentials.ts:23-27`）。

**為什麼會出事**〔讀碼〕：pi-ai 換新 OAuth token 是雙重檢查。兩個請求同時發現 token 快過期，都排進 `modify`；第一個換新，第二個進去時發現已經不需要換，就回 `undefined`（`pi-ai/dist/auth/resolve.js:70-76`，註解寫「another process/request refreshed」）。照合約這是「不動」，在我們的實作裡是「刪掉」。

**重現**〔跑過〕：用真的 `src/agent/credentials.ts`、`createModels`，一個 60 秒後過期的 OAuth 憑證，同時呼叫兩次 `models.getAuth("openai")`：

| | 請求 A | 請求 B | 之後的請求 | 儲存裡的憑證 |
|---|---|---|---|---|
| `memoryCredentials` | 新 token | `undefined` | `undefined` | 沒有了 |
| `InMemoryCredentialStore` | 新 token | 新 token | 新 token | 新 token |

兩邊都只換新一次。我們這邊換新的 token 有存回設定（`onSignIn` 被呼叫一次），所以重開 runtime 會恢復；在那之前，這個 provider 的每個請求都沒有憑證。

**什麼時候會遇到**〔推測〕：用 ChatGPT 登入、token 進入最後 5 分鐘（`resolve.js:46、97-104`），而且同時有兩個模型請求，例如使用者在聊天時排程剛好觸發，或兩個 Bot 同時在跑。沒有在手機上重現過。

**怎麼換**：`memoryCredentials` 留下兩件依賴沒有的事：把設定裡的金鑰和登入放進去（依賴的初值要用 `modify(id, async () => credential)` 一筆一筆寫，是非同步的；`loadModels` 和 `checkProvider` 本來就是 async），以及 `modify` 之後憑證是 OAuth 就呼叫 `onSignIn`。三個合約測試傳的是空憑證（`test/contracts/mcp.ts:101` 等），直接用 `createModels()` 的預設。

**修的時候要附的測試**：上面那個兩個同時的 `getAuth`，舊碼會失敗。

### 2. 邊界驗證：TypeBox 留著寫 schema，檢查交給 pi-schema

**現況**〔讀碼〕：同一份工具參數被驗兩次，用兩套驗證器、兩套規則。

1. `defineAppTool` 的 `prepareArguments` 先清理，再用 TypeBox 的 `Value.Check` 檢查，不過就用 `Value.Errors` 的第一筆丟錯（`src/agent/tools/common.ts:113-119`）。
2. Harness 接著呼叫 pi-ai 的 `validateToolArguments`（`pi-durable/dist/harness/tool.js:249-261`），它用 pi-schema 的 `compile(schema, { coerce: true })`，先轉型再檢查（`pi-ai/dist/utils/validation.js:12、54`）。

pi 在 1.5.0 把參數檢查從 TypeBox 換成 pi-schema（`docs/tools.md:366`）；我們的清理是在那之前寫的（`docs/tools.md:386、408、409`）。

**兩邊各做了什麼**〔跑過〕：同一組參數分別丟給我們的 `prepareArguments` 和 pi-schema 的 `parse`：

| 輸入 | 我們 | pi-schema `coerce` |
|---|---|---|
| `limit: "3"`、`radius_km: " 1.5"` | 轉成數字 | 轉成數字（相同） |
| `days: "Mon"`（陣列參數） | `["Mon"]` | `["Mon"]`（相同） |
| `query: null`（選填） | 拿掉 | 拿掉（相同） |
| `images: "true"`（布林） | **丟錯** `/images must be boolean` | 轉成 `true` |
| `need: 5`（字串） | **丟錯** `/need must be string` | 轉成 `"5"` |
| `query: ""`、`days: []`、`limit: 0`（下限 1） | 拿掉 | 不處理（`0` 會報錯） |
| `query: true`（選填字串） | 拿掉 | 轉成 `"true"` |
| `statements: "SELECT 1"`（項目是只有一個必填文字欄位的物件） | `[{ sql: "SELECT 1" }]` | 報錯 `expected object, got string` |

所以：

- `numbered`（`common.ts:38-42`）和「單一值包成陣列」是重複的。
- 我們的檢查排在前面，把 Harness 本來會轉好的 `"true"`、數字轉字串擋掉了。
- 空字串、空陣列、低於下限的 `0`、選填字串收到布林、字串包成物件，這五條是我們獨有的，要留；而且要排在 pi-schema 前面，否則 `near: true` 會被轉成字串 `"true"`。

**bundle**〔跑過〕：用 rolldown 1.2.15 單獨打包、minify：`Type` 建構子本身 1.9 KB；加上 `typebox/value`、`typebox/compile`、`typebox/system` 是 124 KB（gzip 33 KB）；pi-schema 含 `coerce` 是 42 KB（gzip 12 KB），而它已經在 bundle 裡。沒有打包整個 app，所以省下的大小是估計：約 120 KB、gzip 約 32 KB〔推測〕。

**等價性**〔跑過〕：10 種我們用到的 schema 形狀（`Object`、`Optional`、`Record`、`Union`、`Literal`、`Null`、`Unsafe`、`Enum`、`Partial`、數字和字串的界線）乘上 28 個值，`Value.Check` 和 pi-schema 的 `check` 280 組全部相同。我們用到的建構子就這些（`grep` 數過：`String`、`Object`、`Optional`、`Number`、`Array`、`Boolean`、`Literal`、`Integer`、`Union`、`Record`、`Unknown`、`Null`、`Unsafe`、`Partial`、`Enum`）。

**分兩步**：

1. `src/parse.ts` 的 `check`、`parse`、`decodeEach` 改用 pi-schema 的 `compile`（一個 schema 一個驗證器，放 `WeakMap`，跟現在 `:47-55` 一樣）；`Checked<T>` 的形狀不變。`Locale.Set` 那三句客製訊息（`:6-12`）改成看錯誤的 `keyword` 和 `path` 來決定。其他檔案的 8 處 `Value.Check` 改走 `parse.ts`。
2. `prepareArguments` 改成「清理後用 pi-schema 的 `parse` 過就採用，否則用原值」，錯誤交給 Harness 回報；拿掉 `numbered`。做完這一步，`src/` 裡就沒有 `typebox/value` 了。

**風險**〔讀碼〕：模型看到的用字會變。`must be one of "prices", …` 是 2026-10-29 對著 Qwen3.6 量過才定的（`docs/tools.md:413`）；pi-schema 的是 `expected one of ["prices","margin"]`，同樣列出全部允許值，MCP 工具從 1.5.0 起看到的就是這句（`docs/tools.md:366`）。「要用一個具名參數的物件」那句要保留。`test/tool-args-node.ts:30-31` 斷言的是 TypeBox 的用字，要跟著改。第 2 步要重跑 `docs/tools.md` 那 10 題。

**不做的部分**：不把 `Type.*` 換成 pi-schema 的建構子（表中第 21 項）。

### 3. 工具輸出的截斷

**Harness 已經做的**〔讀碼〕：每個工具結果的文字都過 `boundContent`，上限是 `tool.outputLimits`，沒寫就是 50 KB、2,000 行、保留開頭（`pi-durable/dist/harness/tool.js:218-223、581-584`，`truncate.js:11-12`），被切掉時加一筆 `truncated` 的 diagnostic，寫明丟了幾行幾個位元組（`tool.js:812-817`）。

**我們又做的**〔讀碼〕：`truncated(value, hint)` 在 40,000 字元切，結尾附 `[truncated: N more characters; narrow the request with …]`（`src/agent/tools/common.ts:172-176`）。

**兩者疊在一起**〔跑過〕：把 `truncated` 的輸出再丟給 `boundOutput`（50 KB、2,000 行、head）：

| 輸出 | 我們切了嗎 | Harness 再切 | 我們的提示還在嗎 |
|---|---|---|---|
| 6 萬個漢字 | 切到 4 萬字元（12 萬位元組） | 丟 68,858 位元組 | **不在** |
| 3,000 行短行（3 萬字元） | 沒切 | 丟 728 行 | 本來就沒有 |
| 6 萬個 ASCII 字元，一行或 80 欄 | 切 | 不切 | 在 |

也就是說，中文網頁、長的 GitHub 清單這類輸出，模型看到的是 Harness 的那句，我們寫的「怎麼縮小範圍」被切掉了。

**怎麼換**：拿掉 `truncated`，需要不同上限的工具在定義上寫 `outputLimits`；「怎麼縮小範圍」寫進工具說明，或在結果裡用 `api.diagnostic` 給（`src/jobs/bash.ts:72` 已經這樣用）。要先決定提示放哪裡，這是判斷，不是機械替換。

### 4. 文件變了通知畫面

**現況**〔讀碼〕：`Memories` 和 `Skills` 各自有一組 listener。訂閱的人拿到的是「重讀一次 snapshot」；誰改了文件，誰就要記得呼叫 `changed()`：設定頁存檔（`memory.ts:62`）、`update_memory` 工具（`memory.ts:100`，`host.changed` 是從 `runtime.ts:239` 一路經 `catalog.ts:52` 傳進來的）、技能的兩處（`skills.ts:84、134`）。漏了一處，畫面就是舊的。

**依賴已經有的**〔讀碼〕〔跑過〕：`Harness` 繼承 `Session`（`pi-durable/dist/harness/types.d.ts:828`），有 `watchDoc`。腳本用 `MemoryStorage` 開一個 Harness：文件還沒寫過時 `watchDoc` 回 `undefined`；寫過之後拿到的 watch，後面每次 `commit` 都會收到新值（收到 `two`、`three`、`four`），不需要任何人通知。conversation 範圍的文件沒有跑，只讀了型別（`types.d.ts:1010`）。

**要先決定的事**：文件不存在時沒有東西可以 watch。Bot 的記憶和技能可以在建 Bot 時建立，全域記憶在開 runtime 時建立；或者訂閱時先 `commit` 一次空的。這是設計決定，所以結論寫「先決定建立時機」。行數大概持平，少掉的是「每個寫入的人都要記得」這條規則和 catalog 的兩個相依。

`Forms`、`TriggerRuns`、Bot 清單也是同一個樣子（`src/` 裡手寫的 listener `Set` 有 13 處，`grep` 數的），但它們的狀態有一部分不在文件裡，這次沒有評估。

### 5–8. 四個小的

- **`bytesOf`**〔跑過〕：chord 的 `utf8ByteLength` 有全域 `Buffer` 就用 `Buffer.byteLength`，沒有就自己數（`chord/dist/output.js:238-243`）。app 的主執行緒有 `buffer` 6.0.3 這個 polyfill（`src/main.tsx:1`），所以兩條路都試了：把全域 `Buffer` 換成 polyfill、以及整個拿掉，2,013 個字串的結果都跟 `TextEncoder` 完全相同，包含落單的 surrogate。
- **`normalizeMcpInputSchema`**〔讀碼〕：我們的寫法是 `{ ...schema, type: "object", properties: schema.properties ?? {} }`，依賴的是 `type: schema.type ?? "object"`、沒有 `properties` 才補。差別只在伺服器明寫了別的 `type` 的時候。
- **`normalizePath`／`resolvePath`**〔跑過〕：22 個路徑乘上 4 個 base 再加單獨的 22 個，110 組相同。`PhoneEnv.cwd` 一直是絕對路徑（`src/agent/files/phone-env.ts:216`），所以不會碰到 `process.cwd()`；換的話這個前提要寫成型別或檢查。
- **`sleep`**〔讀碼〕：`src/agent/oauth.ts:146` 需要可中止的等待，所以直接 import 了 pi-ai 的；其他 5 處用 `src/promise.ts` 的。`src/jobs/bash.ts:43-47` 是「先看 `aborted`、再睡 400 ms」的迴圈，用可中止的那個會少等一拍。

## 已經正確重用的

下面這些是照著依賴用的，不要「修」。行號都是〔讀碼〕。

| 用了什麼 | 在哪裡 |
|---|---|
| chord：`Context`、`BACKGROUND_CONTEXT`；`isJsonValue`、`JsonValue`；`utf8ByteLength` | 23 個檔案；`src/agent/tools/common.ts:178`、`src/agent/mcp.ts:48`；`src/agent/files/phone-env.ts:129` |
| pi-durable：`Harness`、`createRegistry`、`defineExtension`、`defineTool`、`hook`、`section` | `src/agent/runtime.ts:259`、`src/section.ts:30`；所有工具都經過 `defineAppTool` → `defineTool`（`common.ts:110`） |
| pi-durable 的文件：`defineDoc` 10 份，寫入都在 `harness.commit`／`api.commit` 的交易裡 | `bots.ts:35、47`、`memory.ts:15、17`、`outside.ts:33`、`skills.ts:45`、`items.ts:20`、`forms.ts:15`、`results.ts:28`、`triggers/runs.ts:95` |
| pi-durable：`IndexedDbStorage` | `src/app/storage.ts:76` |
| pi-durable：`conversation.watch` 和 `WatchCall` | `src/agent/active-view.ts:15-25` |
| pi-durable：`CodingTools`、`createBashTool`、`createToolSearchExtension`、`createCodemodeTool` | `src/agent/catalog.ts:65、76-78`、`src/agent/codemode.ts:139` |
| pi-durable/env：`ExecutionEnv` 的型別、`Result`／`ok`／`err`、`FileError`、`ExecutionError`、`LineScanner`、`getOrThrow` | `src/agent/files/phone-env.ts:3-19、292`、`src/agent/sandbox/workspace.ts:55` |
| pi-durable 的設定型別：`ConversationRetryPolicy`、`DEFAULT_COMPACTION_POLICY`、`CheckpointInfo` | `src/agent/retry.ts:3`、`src/agent/models.ts:18`、`src/doc-policy.ts:3` |
| pi-codemode：`RemoteCodemodeSandbox`、`serveCodemodeRemote` | `src/agent/codemode.ts:135`、`src/agent/codemode-worker.ts:25` |
| pi-env：`Connection`（繼承）、`RemoteExecutionEnv`、`RemoteError` | `src/agent/sandbox/phone-connection.ts:199`、`sandbox.ts:44`、`src/computer/commands.ts:33` |
| pi-ai：`createModels`、`createProvider`、各 provider 的延遲載入、`Models.classify`、`contentText`、`calculateContextTokens`、`createAssistantMessageEventStream`、`uuidv7` | `src/agent/available-models.ts`、`models.ts:120`、`providers.ts:14-35`、`judge.ts:33`、`common.ts:181`、`src/app/usage.ts:24`、`network.ts:96`、`runtime.ts:371` |
| pi-mcp：`McpClient`、`StreamableHttpTransport`、`PipeTransport`、`toLlmContent`、`parseJsonRpcMessage`、`isJsonRpcResponse`、`McpError`、`McpSessionExpiredError` | `src/agent/platform.ts:115`、`mcp.ts:155、328`、`src/computer/commands.ts:159`、`mcp-stateless.ts:82、126-127` |
| pi-mcp/oauth：`McpOAuthProvider`、`adaptOAuthProvider`、`authorizeMcp`、`parseWwwAuthenticate` | `src/agent/mcp.ts:112、119、255、275、291` |
| just-bash：`Bash`、`MountableFs`、`InMemoryFs`、`defineCommand`、`getCommandNames`；just-git：`createGit` | `src/agent/files/shell-worker.ts:2、11、224、258`、`git-command.ts:44-47` |
| `fflate`、`remend`、`pele`、`quickjs-wasi`（經由 pi-codemode） | `attachments-docx.ts:61`、`src/app/streaming.tsx:68`、`src/app/Mermaid.tsx:10`、`codemode-worker.ts:2` |

## 刻意保留的

每一項都有換不了的具體原因。

**原版只能在 Node 跑，或沒有匯出**

- **ChatGPT 登入**（`src/agent/chatgpt.ts`）〔讀碼〕：pi-ai 的 `openai-chatgpt.js` 開 `node:http` 的 callback server、用 `node:crypto`（`:7-8、65-109`），換 token 用全域 `fetch`（`:111`）；`pi-ai/package.json` 的 `exports` 沒有 `./auth/*`。`lazy-oauth.d.ts` 自己寫「Browser bundles must not import this module (the flows are Node-only)」。我們的版本用原生的 loopback 外掛和 `CapacitorHttp`。兩邊的常數要保持一致，升級 pi-ai 時對一次。
- **PKCE、裝置流程**（`src/agent/oauth.ts:99-170`）〔讀碼〕：pi-ai 的 `auth/oauth/pkce.js`、`device-code.js` 同樣不在 `exports` 裡；pi-mcp 的 PKCE 在 `flow.js:62-64` 內部，沒有匯出。
- **MCP 工具命名**（`src/agent/mcp.ts:30-42、82`）〔讀碼〕：見表中第 13 項。
- **SSE 解析**（`src/agent/mcp-stateless.ts:131-145`）〔讀碼〕：pi-mcp 有 `consumeSseStream`（`streamable-http.js:8`），但套件的 `index.d.ts` 沒有匯出它。
- **假裝成子程序的 pi-env 連線**〔讀碼〕：`Connection` 自己 `spawn`（`pi-env/dist/connection.js:270`）、讀 `child.stdout`（`:281`）、對計時器呼叫 `unref()`（`:301`）。所以我們有：`node:child_process` 的 shim（`src/shims/node-child-process.ts`）、模仿 `EventEmitter` 和子程序的 `Events`／`TextStream`／`DaemonProcess`（`phone-connection.ts:55-167`）、拿掉 `unref()` 的建置 patch（`vite-plugins/pi-env.ts`，`test/pi-env-patches.ts` 守著）、以及在手機上重新切 pi-env 的 frame 來找訊息邊界（`daemon-state.ts:58-103`）。`remote-env.js:1-4` 還需要 `node:crypto`、`node:path`（含 `win32`）、`node:string_decoder`、`node:url`，所以有 `src/shims/node-crypto.ts`、`node-path.ts`（`win32` 是手寫的，path-browserify 只有 posix）、`node-url.ts`。main 的 `connection.ts:1-3` 還是一樣。
- **`node:zlib` 的 shim**（`src/shims/node-zlib.ts`）〔讀碼〕：just-bash 的瀏覽器入口自己寫「gzip/gunzip/zcat commands will fail at runtime in browsers since they use node:zlib」（`just-bash/dist/browser.d.ts:9`）；這個 shim 讓它們能用。

**載得進來，但行為不合用**

- **MCP 登入**〔讀碼〕：見表中第 12 項。另外 `startMcpSignIn` 會先試著用 refresh token 換新，成功就不開瀏覽器（`sign-in.js:32-34`）；我們的 `login()` 一律先作廢 token 再走瀏覽器（`mcp.ts:242`）。上游加了 `fetch` 選項之後，這個差別要一起決定。
- **斷線續傳**〔讀碼〕：chord 的 `keepConnected` 是重連迴圈：250 ms 起、加倍到 5 秒、25 秒沒聲音算斷線，這些都是模組常數，`LoopOptions` 只有 `open`、`onState`、`canRetry`、`environment`。我們的連線要補送沒送到的訊息（`received` 計數和保留的 outbox），靜默上限來自 `host/protocol.json`，而且「連不到」只在手機有網路時才計時；整個狀態機有窮舉模型測試（`test/resume-model.ts`，AGENTS.md 的規則表）。
- **codemode 的提示段落**〔跑過〕：拿 `test/tools.snapshot.json` 裡只給腳本、不是需要時載入的 63 個工具，丟給依賴的 `codemodeSection`（說明用同樣長度的字串代替）：預設 3,000 token 的額度下是 11,882 字元，而且放不下的工具要模型自己 `searchTools()`；不設上限是 48,081 字元。我們的寫法是 63 個簽名，共 2,167 字元。`docs/tools.md:18、74` 記著這個選擇。
- **base64**〔跑過〕：Node 26 上，4 MiB 一塊：解碼我們 4.1 ms、`buffer` 6.0.3 是 25.1 ms；編碼我們 59.0 ms、`buffer` 29.3 ms。讀檔是 4 MiB 一塊的 base64（`phone-env.ts:62`），解碼是主要路徑。`buffer` 6.0.3 的 `toString("base64url")` 會丟 `Unknown encoding`。這是在 Node 量的，不是手機；編碼那一半慢，之後量 WebView 時可以順便看。
- **token 估算**〔跑過〕：pi-ai 的 `estimateTextTokens` 是字元數除以 3.5（`estimate.js:2、23`），100 個漢字得到 29；附件的預算用它會低估中文三倍多。`context-shape.ts` 要的是字元數（拿來按比例分配實際用量），而且一張圖算 6,400 字元（`:14-15`），依賴算 4,800。
- **縮圖**〔讀碼〕：我們用 canvas（`Composer.tsx:35-41`）。`createPhotonImages` 是給沒有 canvas 的環境用的：要載入 1,880,773 位元組的 `photon_rs_bg.wasm`，而且它的說明寫「runs on the calling thread: about a second and a half for a 12-megapixel photo」（`pi-durable/dist/images/index.d.ts`）。
- **TypeBox 的建構子**〔讀碼〕：pi-schema 的 `obj` 預設 `additionalProperties: false`。我們有 505 處 `Type.Object`，其中很多是驗證原生外掛回傳的資料，多一個欄位不該失敗；工具參數也會從開放變封閉，`test/tools.snapshot.json` 和模型的行為都會變。`docs/tools.md:48` 的規則（schema 一律用 `typebox` 的 `Type`）維持不變。

**依賴沒有對應的東西**

- **`surviveSuspension`**（`src/app/storage.ts:39-70`）〔讀碼〕：WebKit 在暫停時中止進行中的 IndexedDB 交易。`pi-durable/dist/storage/indexeddb.js` 和 main 的 `indexeddb.ts` 裡都找不到重試或這個錯誤訊息（`grep`）。
- **`idbStore`**（`src/idb.ts`）〔讀碼〕：存的是附件的 `Blob`（`attachments.ts:75`）和草稿；pi-durable 的文件只能是 JSON。
- **`log.ts`**〔讀碼〕：一行一筆的 JSON、遮掉金鑰、留最近 2,000 行給使用者匯出。pi-telemetry 是 span 的合約（`TelemetryContext`、`InMemoryTelemetryContext`），用途不同。如果之後想看每一步花多久，pi-durable 有自己的 span 定義（`DURABLE_TELEMETRY_SCHEMA`，`pi-durable/dist/index.d.ts`），用 chord 的 `withTelemetry` 接進 `Context` 就有，不要再加 `tool.start`／`tool.end` 這種 log。
- **`fit`**（`src/section.ts:12-17`）〔讀碼〕：pi-durable 的 `section` 沒有長度上限。
- **排程**〔讀碼〕：用系統的鬧鐘，不用 pi-durable 的 sleeping task，原因在 [background-triggers.md](background-triggers.md)。
- **`gh` 指令**（`src/agent/files/gh-command.ts`）：沒有任何依賴提供。

**太小，不值得**〔讀碼〕

- `messageOf`（73 處）對 pi-durable/env 的 `toError(error).message`：`toError` 對非 Error 的物件是 `JSON.stringify`，我們是 `String()`。
- `headerRecord`（`src/agent/http.ts:18-22`）對 pi-ai 的 `headersToRecord`：依賴的只吃一個 `Headers`，我們的合併多個來源。
- `AbortSignal.any`（`web.ts:176`、`network.ts:134`）對 chord 的 `withAbortSignal`、pi-ai 的 `combineAbortSignals`：平台的 API 已經夠用。
- `fits`（`phone-env.ts:122-130`）：已經用了 `utf8ByteLength`；換成 `boundOutput` 反而要先編碼整段。

## 依賴有、我們沒接，也沒重做的

知道有就好，要做那個功能時先看這裡。

- **`openTerminal`**（pi-env）：[pi-durable-and-env.md](pi-durable-and-env.md) 已經記了。
- **`openProcess`**（pi-env 1.5.1）：在 daemon 上開一個有 stdin 的程序，pi-mcp 的 `PipeTransport` 是配它用的。我們的 `PipeTransport` 接在 `/exec` 上。只要 `/exec` 還要給容器和背景工作用，換過去不會少東西。
- **`limitMcpContent`**（pi-mcp，`output-limit.js:12`）：MCP 結果超過 20 KB 時留頭尾、切中間，可以把全文存檔。我們的 MCP 結果只過 Harness 的 50 KB 上限。它用全域 `Buffer`（`:40`），app 裡是 `src/main.tsx:1` 裝的 polyfill；沒有在 polyfill 上跑過。
- **`createCodingTools({ images })`**：讓 `read` 自己縮圖。我們現在是在提示裡叫模型先用 `magick` 縮（`src/agent/sandbox/sandbox.ts:27-28`）；手機的資料夾裡沒有 `magick`。代價是上面說的 1.9 MB wasm。

## 只在 main 才有的

1.5.2 沒有，升級才拿得到〔讀碼：`pi-main`，`git diff v1.5.2..HEAD`〕。

- **signals 和 tool park**（pi-durable）：表中第 9 項。CHANGELOG 列的範例正好是我們的情境：「asking a person, a tool that waits for a webhook, a tool that polls, …, a subagent that waits, an approval gate」（`CHANGELOG.md:23`）。`docs/tools.md:365` 當時寫「pi-durable 沒有讓工具結束一輪的方法，所以不用等待中的工具」，這個前提在 main 變了。注意 park 的呼叫雖然不佔執行，那一輪還是開著的；背景工作那種「跑兩小時」的情況合不合用要另外看。
- **`mcpServerSummary`**（pi-mcp）：伺服器說明的第一行。我們的段落放的是整份 `instructions`（`mcp.ts:340-349`），目的不同。
- **`createFitImagesExtension`**（pi-durable，`src/images/fit.ts`）：沒有細讀。
- pi-env 的兩個修正（`listDir` 遇到剛被刪的項目、程式結束時輸出尾巴遺失）是 bug 修正，不是新的 API。

## 可以向上游提的

每一條都能讓我們刪掉一塊「刻意保留」。

| 要什麼 | 我們能刪什麼 |
|---|---|
| pi-env 的 `Connection` 接受一個 transport（送位元組、收位元組、結束），不自己 `spawn` | `node-child-process` shim、`Events`／`TextStream`／`DaemonProcess`、`unref` 的 patch 和它的測試，約 200 行 |
| pi-mcp 的 `startMcpSignIn`／`completeMcpSignIn` 接受 `fetch` | `mcp.ts` 的登入約 40 行 |
| pi-mcp 的 `naming.js` 不用 `node:crypto`（改 WebCrypto 或純 JS 的雜湊） | 讓瀏覽器能從根匯出 import 而不靠 shim |
| pi-ai 把 ChatGPT 的 `refresh`、`toAuth`、token 回應的檢查和「開瀏覽器、收 callback」分開，換 token 的 `fetch` 可以注入，並從 `exports` 匯出 | `chatgpt.ts` 約 50 行，兩邊的常數不用手動對 |
| pi-mcp 支援 2026-07-28（上游 #10416，`docs/tools.md:363`） | `mcp-stateless.ts` 145 行 |

## 建議的順序

1. 第 1 項（憑證）：獨立、有重現腳本、修一個真的 bug。
2. 第 5、6、8 項：各自幾行。
3. 第 3 項（截斷）：先決定提示放哪裡。
4. 第 2 項第 1 步（`parse.ts` 換引擎），量 bundle；第 2 步（`prepareArguments`）要重跑 `docs/tools.md` 的 10 題。
5. 第 4 項（`watchDoc`）：先決定誰建立文件。
6. 第 9 項：等決定要不要升級再評估。

## 跑過的腳本

都在暫存資料夾，用 Node 26 對著 `node_modules` 執行，離線；需要 `src/` 的檔案時用 `--import ./test/vite-imports.js`。

| 腳本做的事 | 結果 |
|---|---|
| import 圖：從一個 `dist` 檔沿著 import／export／`require` 走，列出 `node:*` 和 Node 內建模組 | 沒有 node import：`chord` 的根匯出和 `context`、`json`、`output`、`watch`、`delta`、`surfaces/connection.js`；`pi-durable` 的根匯出、`tools`、`codemode`、`images`、`storage/indexeddb`；`pi-codemode/portable`；`pi-schema` 和 `pi-schema/formats`；`pi-ai/utils/{sleep,retry,headers,hash,abort,validation}`；`pi-mcp` 的 `client.js`、`transports/streamable-http.js`、`transports/pipe.js`、`input-schema.js`、`output-limit.js`。有 node import：`pi-mcp` 的根匯出（`naming.js` 的 `node:crypto`、`stdio.js` 的 `node:child_process`）和 `oauth`（`callback.js` 的 `node:http`、`client-settings.js` 的 `node:crypto`）；`pi-env` 每個主要檔案；`pi-ai` 的根匯出（`provider-env.js` 裡一個 `require("node:fs")`） |
| 兩個同時的 `getAuth`，分別用真的 `memoryCredentials` 和 `InMemoryCredentialStore` | 第 1 項的表 |
| `modify(fn → undefined)` 之後讀回來 | 我們：沒有了；pi-ai：還在 |
| 同一組參數丟給 `defineAppTool` 的 `prepareArguments` 和 pi-schema 的 `parse` | 第 2 項的表。14 組裡結果完全相同的 3 組；另外 3 組兩邊都拒絕，只是用字不同；其餘 8 組一邊接受一邊拒絕，或轉出來的值不同 |
| `Value.Check` 對 pi-schema `check`，10 種 schema × 28 個值 | 280 組相同 |
| rolldown 打包四個入口，minify | `Type` 1,892 位元組；加 `value`＋`compile`＋`system` 123,946（gzip 33,050）；pi-schema 含 coerce 41,781（gzip 11,983） |
| `truncated` 的輸出再過 `boundOutput` | 第 3 項的表 |
| `MemoryStorage` 上的 `watchDoc` | 文件不存在回 `undefined`；存在後每次 commit 都收到 |
| chord 的 `utf8ByteLength` 對 `TextEncoder`，2,013 個字串，全域 `Buffer` 分別是 `buffer` 6.0.3 的 polyfill 和不存在 | 兩次都全部相同 |
| `normalizePath`／`resolvePath` 對 path-browserify 的 `resolve`，110 組 | 全部相同 |
| `codemodeSection` 對 `signatureOf`，63 個工具 | 11,882（額度 3,000 token）、48,081（不設上限）、2,167 字元 |
| base64：我們的對 `buffer` 6.0.3，4 MiB | 解碼 4.1 對 25.1 ms；編碼 59.0 對 29.3 ms；位元組相同 |
| `estimateTextTokens` 對我們的 `estimateTokens`，100 個漢字 | 29 對 100 |

