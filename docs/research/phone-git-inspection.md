# 手機 Git inspection 草稿

狀態：修訂 2 原始碼草稿，尚未執行修訂 2 的測試、建置或安裝。修訂 1 的外部驗證結果另列於下方，不代表本手機執行過檢查。已安裝的 0.5.0 行為不變，仍不支援這些新 inspection 命令。

## 實作與介面

`src/agent/files/git-command.ts` 僅攔截以下本機讀取形式，其他指令仍交給原本 `createGit().execute()`。新邏輯在 `git-inspection.ts`，維持相同無連結 VFS，不建立新工具組、不更動工具 schema、網路 allowlist 或憑證流程。新命令不查 GitHub 身分，也不發網路請求。

| 形式 | 草稿行為 |
| --- | --- |
| `git diff --check` | 比較 index 與工作目錄，只檢查新增行；不含 untracked |
| `git diff --check --cached`、`git diff --staged --check` | 比較 HEAD 與 index；無 HEAD 的初始 index 由上游 diff 處理 |
| 上述形式加 `-- <pathspec>...` | 路徑篩選交給上游 diff；路徑必須在 `--` 後 |
| `git cat-file -t <object>` | 真正 objectStore 物件型別，含 blob/tree/commit/tag |
| `git cat-file -s <object>` | 原始物件 content 的 byteLength，不是 JS 字元數或 pretty 字串長度 |
| `git cat-file -p <object>` | blob/commit/tag 嚴格 UTF-8，保留 BOM 與原有換行；tree 使用公開 readTree 後列出 mode/type/hash/name |
| `git ls-remote` | 本草稿沒有實作，仍由上游明確回不支援 |

`cat-file` 的 object 交給公開 `just-git/repo.revParse`，支援該 API 的 object ID、短 ID、ref 與 revision suffix。尚不支援 reflog、`<rev>:<path>`、index `:<path>`、batch、`-e`、型別轉換或任意組合旗標。新 inspection 形式前的 `-C`、`-c` 等全域選項明確拒絕，不默默忽略。

## diff --check 的保守範圍

重用公開 `Git.execute` 執行 `diff --no-color --unified=2147483647`，不自行讀寫 index 或 object 格式。完整上下文讓草稿能對新增行定位，也能辨認 EOF 新空行。完整上下文可能增加大檔案記憶體與輸出量，尚未效能量測。

預設檢查：新增行尾的空白／tab／CR、縮排中的空白後接 tab、7 字元衝突標記、新增 EOF 空行。刪除行的舊問題不回報。行號按新檔案 hunk 計數，hunk 中的 `+++` 文字仍視為新增內容。

乾淨回 stdout/stderr 空、exit 0；找到問題時診斷在 stdout、exit 2；不支援參數 exit 129；讀取失敗、不能可靠檢查的資料或格式 exit 128／保留上游非零結果，診斷在 stderr，不能默默回 clean。未實作 `--exit-code`、`--quiet`、revision/range 或其他 diff 輸出旗標的組合。

不支援自訂 whitespace 規則：非空 `core.whitespace`、`core.attributesfile`、存在 `.git/info/attributes`，或變動路徑祖先存在 `.gitattributes` 時明確拒絕。這是保守限制，即使檔案沒有 whitespace 規則也拒絕；不宣稱相容所有 Git attributes。上游 combined/unmerged、binary diff、U+FFFD 輸出、quoted/custom-prefix paths、控制字元路徑及無法解析的 hunk／格式也拒絕。U+FFFD 可能是合法文字，但為避免把上游替換解碼當成原始內容而保守拒絕。

## cat-file 文字輸出邊界

`-t`、`-s` 對 binary 也可讀。`-p` 只允許至多 1 MiB 的原始物件內容；非 tree 物件有 NUL 或不是有效 UTF-8 時拒絕，stdout 不留下部分輸出。有效 UTF-8 的其他控制字元沒有另行過濾。tree 名稱若解碼含 U+FFFD 或 NUL 則拒絕，避免猜測原檔名；一般空格不加引號；非 ASCII、控制字元、引號、反斜線的名稱使用 C-style byte quoting。gitlink 類型為 commit、040000 為 tree，其餘為 blob。未提供 `core.quotePath=false` 或多種編碼相容性；不承諾可輸出任意 binary。

## 來源與 API 證據

鎖定依賴仍是 package-lock.json 的 just-git 1.10.0，未更動版本或 lockfile。調查取得的上游 revision：

`blindmansion/just-git@1af49a214954eb505bdd4d7da9e507b0f81877b6`

原先讀取 main，後續 public index、repo index、reading、rev-parse、diff-algorithm 以該 revision 重新查詢；git.ts、lib/types.ts、commands/diff.ts 等來源也在該 revision 下補存以便核對。公開 API 簽章：

- 根入口的 `createGit`／`Git.execute(rawArgs: string[], ctx: CommandContext): Promise<ExecResult>`，這也是既有手機接線使用的 API。
- `Git.findRepo({ fs, cwd }): Promise<GitContext | null>`；`GitContext.objectStore.read(hash): Promise<{ type, content: Uint8Array }>`。使用現有 packed/loose 物件處理，不自造 store。
- `just-git/repo.revParse(repo, rev): Promise<string | null>`。
- `just-git/repo.readTree(repo, hash): Promise<TreeEntry[]>`，項目為 mode/name/hash。

外部操作者回報：修訂 1 在相同基底、相同完整 patch 及 exact lockfile 的隔離 checkout，已通過 npm ci --ignore-scripts、88 個檢查、npm run check 與 npm run build，公開 API 能對發布相依套件編譯及執行。這解決了修訂 1 所用公開 API 的外部相容性疑慮，不代表本手機已測試，也不證明上述上游來源 revision 等於 lockfile integrity 對應的發布原始碼。手機仍沒有 node_modules 或 Node/npm；來源身分與 rebuilt-phone 驗證仍未建立。修訂 2 沿用相同 API，尚待重新驗證。

## ls-remote 的獨立阻礙與最小方案

內部 `src/lib/transport/transport.ts` 有 `SmartHttpTransport.advertiseRefs(): Promise<RemoteRef[]>`，呼叫真正 smart HTTP `discoverRefs`，不 fetch pack。該 class 未從套件四個公開 exports 提供。server 的 `advertiseRefsWithHooks` 是服務端，不是向 GitHub 查 refs。

最小上游方案是從公開入口匯出 `SmartHttpTransport` 與 `RemoteRef`／必要型別，或提供專門的 readonly `advertiseRemoteRefs` facade。已讀 constructor 為 `(local: GitContext, url: string, auth?, fetchFn?, onProgress?)`；readonly facade 更能避免在 repo 外查詢時硬造 local context。此處只是提案，沒有加依賴、patch 或新 API 呼叫。

若採既有 Vite build-patch 做 facade，須先取得並核對 1.10.0 發布 bundle，像 just-bash patch 一樣要求匹配唯一且升級即失敗，再用測試驗證真實 remote refs、pattern、無本機 refs/objects 寫入、HTTP/network error 與僅 GitHub 網路。不能猜測 bundle 符號，更不能手寫 pkt-line 或用 fetch pack 假裝 ls-remote。

## 回歸測試：已新增，未執行

`test/bash/git-inspection.ts` 使用現有 `just-bash/browser` 的 Bash、InMemoryFs 與真正 gitCommand，fixture 完全在記憶體內；注入 fetch 若被呼叫就丟錯，不碰使用者 repo、不需要真憑證。也直接測純 patch parser 與物件 I/O 失敗。package.json 的 npm check 已接上測試。

涵蓋工作目錄／staged 隔離、unborn index、路徑篩選、行號、空白與衝突標記、EOF、刪除舊問題、unknown flags／全域旗標／格式、binary、attributes、缺 repo／revision／object；cat-file 四種類型、UTF-8 位元組大小、BOM、tree pretty／quoted names、revision／short ID、無效 UTF-8、NUL、大小限制與 I/O error。網路呼叫數應為零；未實作的 ls-remote 沒有偽造網路測試通過紀錄。

尚需於可執行依賴的環境執行：

```sh
node --import ./test/vite-imports.js test/bash/git-inspection.ts
npm run check
npm run build
```

接著需在重新建置且實際載入草稿的 App 測工作目錄／staged、真實 packed objects、錯誤與輸出串流。對舊 0.5.0 執行 bash 不會測到本草稿；本手機沒有 Node/npm，以上命令均未執行，也未建置或安裝。

## 修訂 1 外部驗證與修訂 2 待驗證

外部操作者提供的修訂 1 patch SHA-256：`8861c61bc3bc066fd0b3d6f6bfd825e43cdea7a9613a05d2884ed180db4c068f`，基底 `4e62dcdb82314f9fa3ede1b23da4ac1c5bd72989`。除了上述 npm 檢查，外部的 git apply --check、git diff --check 也通過；不是手機執行證據。沒有外部原始碼修補，只有獨立 oracle harness。

外部以 Native Git 2.54.0 Apple Git-157 比對 14 個案例，修訂 1 有 5 個不符。依操作者提供的精確輸出，修訂 2 已在手機修改：

1. 補上 7 個 `|` 的 ancestor conflict marker。
2. conflict marker 每行只輸出 `path:line: leftover conflict marker` 加 LF，不加句點或 `+content`；一般空白診斷保留原格式。
3. EOF 新空行只輸出一次，行號指向整個 trailing blank run 的第一行。
4. 若 trailing blank run 先有既存空行、再新增空行，也使用整個 run 的起點行號。
5. tree pretty 的一般空格不加引號；Unicode 與 TAB 名稱仍跳脫。

已新增 14 個 stdout/stderr/exit 完整比對的 oracle 回歸案例，涵蓋上述 5 個差異與需保留的普通行尾空白、8 字元標記、7 標記後無空格、CRLF、space-tab、unchanged、staged whitespace、Unicode/TAB 名稱行為。預期值根據操作者提供的 native 輸出／相容行為，並非手機另跑 native Git 所得。

修訂 2 的所有新增與既有測試均尚未重新執行，未宣稱外部或手機通過。仍須重新執行回歸測試、npm run check、npm run build、git apply --check、git diff --check 與獨立 native oracle；rebuilt-phone 驗證持續待補。`ls-remote` 保持 deferred。
