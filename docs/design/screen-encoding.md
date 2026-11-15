# 畫面觀察編碼：第一步（2026-11-16 撤回）

**撤回**：`src/screen/` 一直沒有接上工具，只有測試在用，2026-11-16 刪掉。理由：在同一個 fixture 上，新編碼比 Kotlin 現在的輸出長（324／269 對 186／165 字元，見下面〈離線證據與基線〉）；接上它要把整棵樹送過 bridge，這個成本沒量過；收尾的實測也顯示等待、找目標要貼著原生的活節點做（`docs/design/errands-report.md`）。畫面編碼留在 Kotlin 和 Swift。`test/code-rules.ts` 現在會擋「app 的入口走不到、只有測試在用」的檔案。下文留作紀錄。

核心目的：模型用同一份精簡文字辨認畫面、引用目標、看出動作前後的差別，之後不必為每個平台重讀不同格式。這一步只加入合約與純函式；既有工具、原生回傳與提示不變。

## 邊界

- `src/screen/driver.ts` 是新詞彙的唯一來源。`Observation` 的 TypeBox schema 同時產生 TS 型別；JSON fixture 經 `src/parse.ts` 驗證，沒有另一份手寫 schema。
- `Role`、`State`、`Key`、`Action`、`Reason` 暫留 TS。第一步沒有 Go 消費者，不在 `host/protocol.json` 手抄第二份清單；電腦 adapter 接上時再把來源搬到 protocol，讓 TS 與 Go 都讀它。
- `Surface` 區分 `front`、`background` 與指定的 `{ window }`；座標用 observation 的同一單位。
- 原生 `ref` 在一個 surface 內唯一且穩定，不可重用來指另一個節點；節點依樹的前序排列，`depth` 表達父子，`window` 指向 windows。
- 密碼由 backend 遮罩後回傳；encoder 不接收原始密碼，也不把 JPEG 放進文字。

## 純函式與壽命

`encode(observation, { conversation, surface }, previousIds?)` 回傳文字、具名行、`ids` 與 `truncated`，不修改輸入。呼叫端為每個 conversation + surface 保留各自的 `ids`，切回來時傳回原本那份；對話結束就釋放。不同 scope 傳來的 ids 不沿用。e1 起算、刪掉後不重配，重新出現的 ref 沿用原編號。

`diff(before, after, scope, previousIds?)` 先以相同 ID 歷史編碼兩邊，只回有變的行與 `gone:`。`ids` 是 after 的狀態；相同觀察回空字串。`gone:` 列真正消失且之前有顯示的節點，以及消失的視窗；因編碼裁剪而暫時不顯示的節點不冒充消失。

## 裁剪規則

- 空白壓成一格，名稱和值各最多 300 個 UTF-16 字元（含末尾的 …）。有可用名稱就不寫座標；空白名稱才用 `@x,y`。
- 沒有名稱、值、狀態的 group/window wrapper 不顯示；仍走訪子節點，縮排只計算可見的祖先。可點卡片內的文字不被吞掉。
- 同一父節點下連續同角色最多顯示 25 個，子節點不會重設父層的 run，也不跟著被整棵刪掉。換父節點、視窗或角色會重算。
- `truncated` 是 backend 已省略的數量，加上本次被省略或縮短的項目數；一個節點的名稱和值都縮短仍只算一次，視窗標題縮短也算一次。空 wrapper 沒有內容損失，不計入。

## 離線證據與基線

實際執行 `node --import ./test/vite-imports.js test/screen-observation.ts`：下表為字串 `.length`，不含檔案最後的換行，不是 tokens 或裝置量測。三組 fixture 皆為手建的虛構資料。

| Fixture | before | after | diff |
|---|---:|---:|---:|
| settings-apps.json | 324 | 269 | 67 |
| chat-list.json | 629 | 169 | 201 |
| checkout.json | 655 | 250 | 171 |

Settings 的 `*.kotlin-before.txt` / `*.kotlin-after.txt` 是依目前 Kotlin 格式手建的對照，不是原生執行結果：`ScreenElements.kt:74-104` 的 walk 一律寫座標、標題是 text、開關是 checked/unchecked，點擊卡片的文字子節點不顯示；這裡假設卡片自己的名稱就是 App 名稱（`ownLabel` / `labelOf`，同檔 `:130-142`）。沒有複製 Kotlin 演算法到測試。

實際讀取這些文字檔計數：Kotlin elements before/after 為 **186 / 165** 字元，新編碼完整輸出為 **324 / 269**（其中節點行 **257 / 202**），diff **67**。新格式在這個小 fixture 反而較長，因為保留三張卡片的儲存空間文字、ID、縮排與 metadata；不把資訊刪除誤報成節省。舊工具還會加 `src/phone-screen/tool.ts:32-44` 的固定說明，本比較沒有把它算入 Kotlin elements，也沒有宣稱實機節省。

步驟覆蓋檢查讀目前 PhoneScreen / Browser 的 schema，而不是要求原生現在實作未來的 `Action`。Kotlin 解析各自 `ScreenStep.of` / `Step.of` 的 action when，按鍵解析實際 map 與 key 比較；Swift 在 `ios/AgentScreen/` 存在時解析 action/key switch。兩邊都檢查多宣稱與漏宣稱，字串、註解與巢狀的其他分支不算。這個 worktree 沒有該 iOS 資料夾；Swift parser 僅有離線語法 fixture，沒有原生執行證據。
