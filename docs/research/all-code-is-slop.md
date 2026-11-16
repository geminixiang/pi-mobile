# All code is slop：poteto 的規則和 pi-mobile 對照（2026-11-16）

來源：<https://artesano.build/all-code-is-slop>。這是第三方根據 poteto（Lauren Tan）在 AI Engineer Code Summit（2026-11-11）的演講整理的學習筆記，不是演講本身。文章沒寫出 lint 工具和設定檔的名字；它舉的規則條文自己標了「Illustration」，只是示意，不是真正的錯誤訊息。下面的數字都是講者自己說的，沒有驗證過。

`.pi/skills/` 的 `architect`、`blast-radius`、`correct` 就是改寫自她的 pstack，所以兩邊的方法本來就是同一套。

## 論點

Agent 讓產出變多，所以品質要靠環境來保證。錯誤要在越上層抓到越好，從上到下依序是：

1. 架構
2. 靜態檢查（lint、型別、CI）
3. 驗證
4. 少量文字說明
5. 人工審查

另外三個原則：
- 每次被糾正，就把它變成一個確定性的檢查。
- 先擋住新增的違規，再清理舊的。
- 「如果修法是結構性的，就只用結構性的修法；寫成規則說明只是症狀。」

## 對照

「已有」「部分」「沒有」的判斷，是讀 `test/code-rules.ts`、`AGENTS.md` 和 `grep src` 得出的。

| 她的規則 | pi-mobile | 狀態 |
|---|---|---|
| 產品程式碼禁用 `useEffect`，只有框架自己的 API 能用 | `EFFECTS` ratchet：`useEffect`、`useLayoutEffect` 和 timer 只能出現在名單列出的 43 個檔案，總數 98，只降不升；讀 store 用 `useSubscribed` | 部分：擋住新增，但沒歸零。`src/` 裡有 67 次 effect 呼叫，分散在 28 個檔案 |
| 禁用 timer（`setTimeout`、rAF、idle callback）。理由是 timer 快速建立又銷毀，觸發大量 GC，造成卡頓 | 跟 effect 算在同一個 `EFFECTS` 計數裡；等待只能用 `sleep`，`setTimeout(resolve` 只准在它的擁有者裡出現 | 部分：timer 沒有自己的上限。`src/` 有 42 處 timer |
| Electron 的 renderer 不能 import main，要跨過去只能走框架的 IPC，用依賴圖分析工具強制 | 我們的邊界是 WebView 和原生之間，只能走 Capacitor plugin（`test/plugins-node.ts` 檢查兩邊合約一致）。還有：`src/computer/` 不能 import `sandbox`；只有 phone-screen 能碰無障礙服務；功能資料夾不能 import `AgentRuntime`；資料夾之間的循環 import 有 ratchet（`TANGLED_IMPORTS`） | 已有 |
| 一個功能一個資料夾 | AGENTS.md 有規定（「Code is grouped by feature」），但只靠審查 | 部分 |
| 禁止約 99% 的註解 | `test/no-comments.ts`：只准 `// why:`，目前 145 個 | 已有 |
| lint 的錯誤訊息要寫出正確修法 | `code-rules` 的錯誤訊息都會寫要改成什麼 | 已有 |
| 規則和負責檢查的工具對照成表 | AGENTS.md 的 Rule ／ Enforced by 表 | 已有 |
| 有競態問題時用 TLA+ 建模驗證 | `test/resume-model.ts` 窮舉檢查恢復連線的協定，也必須能抓到已知的 bug | 部分：只做了一個協定 |
| 功能地圖，讓 agent 跑 App、用 CDP 驗證 | `docs/feature-map.md`、`test/device/*`、`.pi/skills/device-testing` | 已有 |

## 值得補的

1. **effect 在元件裡歸零**：她的做法是只讓框架的少數 API 用 `useEffect`。我們的對應做法是把 effect 收進幾個擁有者 hook（像 `useSubscribed` 那樣），元件裡一個都不留，再把 `EFFECTS` 改成只列那幾個 hook 檔。這是大改動：28 個檔案、67 處，而且動到 `src/app/`，照 AGENTS.md 要量效能。
2. **timer 自己一個 ratchet**：先把 timer 從 `EFFECTS` 拆出來單獨計數，這樣才看得出 timer 有沒有減少。成本很小。
3. **一個功能一個資料夾改成用檢查強制**：新檔案只能放在功能資料夾，或 `src/` 根目錄的共用檔。
