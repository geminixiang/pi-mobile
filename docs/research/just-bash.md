# 手機資料夾的 bash（just-bash）實測

2026-10-23，S24，just-bash 3.6.0。Bot 沒有連電腦時，`bash` 跑在手機上的 just-bash（TypeScript 寫的 bash，跑在 Web Worker），檔案操作經主執行緒交給 `BotFilesPlugin.java`。

## 怎麼測

- `test/bash/cases.json`：152 個情境（另有 16 個是模型常寫的寫法：BRE、join、`find -exec`、相對日期、`$(( ))` 裡的函式…），涵蓋語法（參數展開、陣列、函式、here-doc、process substitution、glob、`set -e`、`pipefail`）、coreutils、grep/rg、sed、awk、jq、中文與奇怪的檔名、CRLF、二進位、模型常寫的管線。
- `test/bash/gnu.sh` 在 Debian 13（bash 5.2、GNU coreutils、gawk、jq 1.7）跑同一批情境，產生 `gnu.json`。
- `CDP_PORT=… node test/bash/run.ts` 在手機上開一個暫時的 Bot 跑一遍，和 GNU 比 stdout 與 exit code；不一樣但已知的差異記在 `accepted.json`，其他算回歸。跑完會刪掉那個 Bot。差異是刻意接受的時候，加 `--accept` 重寫 `accepted.json`。
- 另外手動測了：路徑逃脫、別的 Bot 的資料夾、大檔案（60 萬行、4 MB）、300 個小檔、輸出洪水、無窮迴圈的逾時、中止、同時執行、深遞迴。

## 我們這邊修掉的

| 問題 | 原因 | 修法 |
|---|---|---|
| `echo x > /dev/null` 在資料夾裡建出真的 `dev/null` 檔，`cat /dev/null` 會讀到之前的輸出 | 資料夾沒有 `/dev` | `/dev` 掛一個裝置檔系統：`null` 丟掉寫入，`zero`、`urandom` 可讀 |
| 每個指令前都向原生查 `/usr/bin/<指令>` 兩次（約 8 ms） | just-bash 用檔案系統找指令 | `/bin`、`/usr/bin` 掛記憶體裡的指令清單；`which` 也因此能用。500 個 subshell 從 4.6 秒變 0.07 秒，中位數情境 205 → 95 ms |
| `split` 失敗、`cp a b` 說無法判斷是不是同一個檔案 | stat 沒有檔案身分 | 資料夾沒有連結，正規化後的路徑就是身分 |
| `mktemp` 失敗、寫 `/tmp/x` 會在資料夾根目錄多一個 `tmp` | 沒有 `/tmp`、沒有原子建立 | `/tmp` 對應到資料夾的 `.tmp`（`read`、`write` 也一樣），原生 `create` 做原子建立，`TMPDIR=/tmp` |
| `chmod +x s.sh; ./s.sh` 被拒 | `chmod` 不做事 | 原生 `chmod` 設定可執行位元，stat 回報 |
| 60 萬行的 `awk`、`cut` 中途停下；`yes \| head -n 500000` 默默只給 10 萬行 | just-bash 預設的迭代上限是 10 萬 | 迴圈、指令數、awk、sed、jq 上限提高到 1,000 萬；真正的保護是逾時和中止 |
| 在不存在的目錄執行，`pwd` 照樣成功 | 沒先檢查 | 先確認工作目錄存在，否則回 `spawn_error` |
| `gzip`、`gunzip`、`zcat` 不能用 | `node:zlib` 的替身只會丟錯；Worker 裡沒有 `Buffer` | 用 fflate 實作 `gzipSync`、`gunzipSync`，Worker 載入 `Buffer`；和 Mac 的 gzip 互相解得開 |
| awk 處理超過 100 萬筆、grep 超過 100 萬行就停（`record array limit exceeded`） | `maxArrayElements` 預設 100 萬 | 和其他上限一樣提高到 1,000 萬；200 萬行的 awk 加總 3.8 秒、`sed -i` 6.4 秒 |
| `head -c 1M /dev/zero` 只給 64 KB | `/dev` 一次讀取回固定大小 | 一次讀取改為 4 MB；`/dev/urandom` 分 64 KB 填（`getRandomValues` 的上限） |
| 檔名 255 字的檔案寫不進去（EIO） | 原生端原子寫入的暫存檔名是 `.<檔名>.pi-write`，超過 255 | 暫存檔改用 `File.createTempFile`，和檔名長度無關 |

## 安全

- `..`、`/../..`、絕對路徑都停在 Bot 自己的資料夾；碰不到別的 Bot 的資料夾，也碰不到 `/data`、`/sdcard`、`/etc`、`/proc`。
- 沒有 python、node、curl、wget、tar。
- 網路只有 `git` 和 `gh`，只到 GitHub（`github.com`、`api.github.com`、`uploads.github.com`、`codeload.github.com`、`*.githubusercontent.com`，https）。請求從 Worker 交給主執行緒，經原生 HTTP 送出（`github.com` 的 git 協定沒有 CORS 標頭）；GitHub token 在主執行緒才加上，bash 裡的環境變數、檔案、`git config` 都看不到它（`files/folder-network.ts`）。
- 「資料夾不能連網」不是安全界線：Bot 本來就能用 `web_fetch` 對任意網址送 GET、用 `github_api` 寫入，資料夾的內容模型也讀得到。要守的是憑證不進 bash：送出一次請求的傷害有限，token 外流則一直能用。
- 不支援 symlink 和 hard link（`ENOSYS`）。

## 效能（S24）

| 工作 | 時間 |
|---|---|
| `seq 1 600000 > n.txt`（4 MB） | 0.8 秒 |
| 對它 `wc`、`tail`、`awk` 加總 | 2.1 秒 |
| `sort -rn` 加 `grep -c` | 1.3 秒 |
| 建 300 個小檔 | 3.6 秒（每個檔約 3 次原生呼叫，每次約 3 ms） |
| 輸出 130 萬字元 | 0.2 秒，超過的部分寫到 `/tmp/pi-output-*.log` |
| `yes \| head -n 500000` | 8.9 秒：管線不是串流，`yes` 先產生到上限才交給 `head` |

## 我們 patch 掉的 just-bash 問題

上游沒修、或修了還沒發版的，在建置時直接改 just-bash 的瀏覽器版（`vite-plugins/just-bash.ts`）。每個 patch 是一段原文和替換，原文在 bundle 裡必須剛好出現一次，否則建置失敗並指回這份文件。just-bash 鎖定在 3.6.0；升級時這些 patch 要對新的 bundle 重做，上游已經修好的就拿掉。`npm run check` 會跑 `test/bash/patches.ts`，用 Node 載入 patch 過的 bundle 驗證 38 個情境。

| 問題 | 原本 | 上游 |
|---|---|---|
| `jq unique` | 不排序 | 沒人報 |
| `jq @csv` | 字串不加引號 | 沒人報 |
| `od -tx1`（格式黏在選項上） | 忽略格式，印八進位 | 沒人報 |
| `grep` 的 BRE `\+`、`\?` | 當成字面的 + 和 ?，`grep -o '[0-9]\+'` 什麼都找不到 | 沒人報 |
| awk 讀取 `a[k]` | 不會建立元素，`NR==FNR{k[$1];next} $1 in k` 這種兩個檔案的 join 什麼都不印 | 沒人報 |
| awk `length(陣列)` | 回 0 | #647 |
| `awk -v OFS=…`（ORS、SUBSEP 也是） | 不生效 | 沒人報 |
| awk `printf "%05.1f"`、`%+f`、`% f` | 不補零、不加正負號 | #608 |
| `sort -k1,1nr` 遇到行首空白（`uniq -c` 的輸出） | 第一欄變成空字串，排序錯 | 沒人報 |
| `sort -g` | 不支援 | 沒人報 |
| `head -n -N` | 不支援 | 沒人報 |
| `xargs -I{}`、`-n2`、`-d,`、`-P4` | 選項值黏著寫就不認 | #466，修正 #536 未合併 |
| `paste -s` 沒給檔案 | 不讀 stdin | 沒人報 |
| `awk -f 程式檔` | 不支援 | #468 |
| `sed '1a\文字'` | 多印一個反斜線 | 沒人報 |
| `$(( $(函式) ))` | 找不到函式（遞迴函式算不出來） | #610 |
| `{1..N}` 超過 1 萬 | 默默只展開 1 萬個 | #610 |
| `date -d '2024-02-28 +1 day'`、`3 days ago` | 不支援相對日期 | 沒人報 |
| `yes` | 跟著迭代上限產生 1,000 萬行才交給 `head`（S24 上 7 秒） | 刻意的設計；我們改成最多 100 萬行 |
| `uniq -c` | 數字寬 4 | 格式差異；改成和 GNU 一樣寬 7 |
| awk `printf` | 每呼叫一次就重算整段輸出的位元組數，O(n²)：4 萬行 28 秒，10 萬行超過兩分鐘（`print` 是線性的） | 沒人報。改用和 `print` 一樣的長度檢查後 10 萬行 0.15 秒 |
| awk 沒加括號的 `length` | 當成變數，印空字串；`awk 'length > 80'` 什麼都不印 | #608 |

## 還留著的差異（`accepted.json`）

152 個情境裡 127 個和 GNU 一樣。其餘 25 個：

- 會直接報錯的：`trap`（沒有實作）、`grep -s`、`seq -f`、`realpath`、`cmp`（#611）、`dd`、`bc`、`shuf`、`cksum`。
- `head`、`tail`、`sort`、`cut`、`sed` 不認 `--`（選項結束），awk 把 `--` 當檔名；`cat`、`wc`、`grep`、`ls`、`rm`、`cp`、`mv` 正常。沒人報。
- `tr '\0' x`、`tr -d '\0'`：`\0` 被當成字元 0，NUL 不會被換掉或刪掉（`\t`、`\n` 正常）。沒人報。
- 二進位：`printf '\xff' > f` 寫成 UTF-8 的兩個位元組（重導向依內容猜編碼），二進位資料寫不出來。
- 和 GNU 不同但不算錯：`cut -c`、`wc -m` 以字元計（GNU 以位元組）；`ls`、`find` 對中文用語系排序；`grep -r` 不加 `./`；`rg` 一律印行號；`wc` 的欄寬；`tree` 用 ASCII 線條；`od -c` 的間距；背景工作 `&` 不會真的並行；`date -d '… 12:00 +3 hours'` 我們加三小時，GNU 把 `+3` 當成時區。
- `sed -i.bak` 不留備份、`env -i` 多印 `PWD`、`tree` 的目錄數算錯。

## 模型實際用起來

四個工作：帳目分類加總並找最大一筆、log 依模組和小時統計 ERROR、JSON 篩選加總存成 CSV、寫腳本依序改檔名並執行。GPT 6 Luna、Claude Haiku 5.5、GPT 6.1 Sol 各跑一次，12/12 答對，沒有一次卡在上面的差異。

說明裡原本只寫「沒有其他程式」，Luna 被要求「用 python 算」時會放棄；加上「沒有 python，用 awk 或 jq 算」之後，它改用程式模式算出正確答案。Haiku 本來就會改用 awk。

## 份量與嚴苛操作（2026-10-24，S24）

48 個情境，三類：規模、濫用、邊界。腳本直接呼叫 Bot 資料夾的 `exec`，不經過模型。

**規模**（修完 awk printf 和 `maxArrayElements` 之後）

| 工作 | 時間 |
|---|---|
| 寫 200 萬行（14 MB）、`wc -l` | 2.7 秒 |
| 對它 awk 加總 / `sort -rn` / `sed -i` | 3.8 / 3.0 / 6.4 秒 |
| 50 萬行過 8 段管線（awk、sort、uniq -c、sort -rn、head、awk、tr、sed） | 3.0 秒 |
| 100 萬行 `sort \| uniq -c \| sort -rn` | 5.9 秒 |
| awk 產生 10 萬筆 JSON（3.4 MB）再 `jq group_by` | 2.3 秒（修之前 awk 這段超過 5 分鐘） |
| 14 MB 的 gzip 來回 | 3.3 秒 |
| 建 2,000 個小檔 / `find \| xargs grep` 掃它們 / `rm -r` | 20 / 6.7 / 0.1 秒（每個檔 3 次原生呼叫，10 ms） |
| 60 層深的目錄 | 0.4 秒 |
| 1 MB 的單一行：`cut -c`、awk `length`、`grep -c` | 0.8 秒 |
| 輸出 14 MB 到對話 | 2.0 秒（工具呼叫時會改寫到 `/tmp/pi-output-*.log`） |

**濫用**：無窮迴圈由逾時收掉（逾時 2 秒，實際 4 秒回來），之後下一個指令 0.1 秒；`f(){ f|f; }; f` 和 3,000 層遞迴在第 100 層被擋（`maxCallDepth`）；5 次各 3 MB 的變數、200 個連續指令、`&` 背景工作、執行中 abort，之後都正常；4 個指令同時送、兩個 Bot 同時跑，各自的檔案互不可見。擋下來的上限：`{1..1000000}`（brace 的工作上限 10 萬）、`yes` 100 萬行、`seq` 1,000 萬。

**邊界**：空白、引號、中文、emoji、開頭是 `-` 的檔名；255 字的檔名；CRLF；10 萬位元組的二進位檔經 `cp`、管線、gzip 來回後 md5 相同；`cat 目錄`、`rm 不存在`、`mkdir 已存在` 的 exit code；`cd /..`、`/proc`、`/data`、`/etc` 都看不到；`ln -s` 回 ENOSYS；`chmod 000` 不擋讀取（資料夾沒有權限位元）；3,000 行的 here-doc 腳本 `set -euo pipefail` 照 GNU 停在 `false`；陣列、關聯陣列、`BASH_REMATCH`、process substitution、`$(( ))` 裡的指令替換、`date -d` 相對日期、`xargs -I -P`。

**模型實際用起來（第二輪）**：六個工作各放一份資料在 Bot 資料夾：5,000 筆帳目（note 欄位有引號包的逗號）分類加總和最大一筆；10 萬行 log 的 ERROR 總數、某小時的數量、前三個 module；2 萬筆 JSON 篩選排序存成 CSV；2,000 個使用者對 2 萬筆訂單的 join 前 5 名；300 個檔案寫腳本改名；散文裡 400 個數字加總。答案由 Python 事先算好。

| 模型 | 結果 | 時間 |
|---|---|---|
| Claude Haiku 5.5 | 6/6 | 81 秒 |
| GPT 6 Luna，`files` 說明改之前 | 3/6 | 237 秒 |
| GPT 6 Luna，改之後 | 6/6 | 94 秒 |

Luna 錯的三題都不是 bash 的問題：它用 `read` 讀檔案的前 1,000 行就開始算（log 的 ERROR 數成了 68）、JSON 只有一行而 `read` 截在 51,200 字（篩出 1 筆）、或是認定 CSV 是附件而沒去資料夾看（連 `ls` 都沒跑就回「請附上檔案」）。`files` 的說明加上一句「使用者提到的檔案多半已經在資料夾裡：先 `ls`，用 bash 處理而不是整個讀進來」之後，三題都用 bash 算對。

## 為什麼不是別的（2026-10-24）

手機資料夾的 bash 要同時滿足：跑在 WebView 裡（沒有 `SharedArrayBuffer`，見 phone-runtime.md）、只碰得到 Bot 自己的資料夾、使用者不用另外裝東西、模型寫的是 bash 不是 sh。對照過的替代方案：

| 方案 | 真實度 | 擋不擋得住 | 代價 | 不選的原因 |
|---|---|---|---|---|
| **just-bash**（現在） | bash 語法齊，工具是 TS 重寫，127/152 和 GNU 一樣 | 檔案系統是我們接的 VFS，天生只看得到 Bot 資料夾 | 約 20 條 build 時的 patch，升級要重做 | — |
| 把 bash、coreutils、gawk、jq 的 arm64 靜態檔打包成 `lib*.so`，`ProcessBuilder` 執行 | 真的 GNU | **擋不住**：行程是 app 的 uid，`cat ../../app_webview/…` 讀得到對話資料庫和設定。要擋要用 `isolatedProcess` 加 fd 傳遞和 C 寫的 launcher，SELinux 對 isolated_app 能不能 exec app 的 lib 沒有定論 | APK 多 5–8 MB、`useLegacyPackaging`、四個 ABI | 隔離要自己做，而且做錯就是整個 app 的資料外洩 |
| Wasmer 的 `bash`（WASIX） | 真的 bash | 有 | 需要 `SharedArrayBuffer`，WebView 沒有 cross-origin isolation；外部工具要另外包 | 跑不起來 |
| `wasi-sh`（BusyBox ash 編成 wasm32-wasi） | ash 不是 bash：沒有陣列、`[[ ]]`、process substitution；管線一樣不串流 | 有 | 小 | 比 just-bash 更不像模型寫的 bash |
| v86 / JSLinux（在瀏覽器模擬一台 x86 跑 Linux） | 真的 Linux，有 python | 有（VM） | image 數十 MB，開機數秒，單核模擬，資料夾要經 9p 橋接 | 太重，且只是為了 awk 和 jq |
| Termux（`RUN_COMMAND`） | 真的 Linux | 沒有：Termux 自己的家目錄和網路 | 使用者要裝 Termux、開 allow-external-apps | 那是「手機內 sandbox」的方案（android-system-capabilities.md），不是資料夾的 shell |
| 系統 Linux Terminal（AVF） | 真的 Debian VM | 有 | S24 不支援 | 換手機再說 |
| 不給 bash，只給 read/write/edit 和 code mode 的 JS | — | 有 | 模型要改用 JS 做文字處理 | 弱模型自然會寫 awk、jq；四個工作 12/12 是靠 bash 做到的 |

結論：在這組限制下，just-bash 是唯一一個「純 JS、VFS 可接、語法是 bash」的選擇；它的代價是上游還年輕，差異要自己補。補的方式已經讓升級時哪條失效會在 build 就知道，上游也在動（我們找到的有 9 項已有 issue，`/dev/null` 已合併未發版）。

## Cloudflare Computer 怎麼用（2026-10-23，v0.7.0）

[cloudflare/computer](https://github.com/cloudflare/computer) 的 worker-shell backend 也把 just-bash 接到自己的檔案系統：每次執行在 Dynamic Worker 裡 `new Bash({ fs: WorkspaceFsAdapter })`，檔案操作經 Workers RPC 回到 Durable Object 的 SQLite（`packages/computer/src/backends/worker-shell/adapter.ts`、`entrypoint.ts`）。鎖定 just-bash 3.2.0，標為 Experimental。

| 我們遇到的 | 他們 |
|---|---|
| `/dev/null` 變成真的檔案 | 一樣遇到，adapter 裡把 `/dev/null` 做成虛擬檔、寫入丟掉，有測試；沒有 `/dev/zero`、`/dev/urandom` |
| 每個指令都查 `$PATH` | 一樣遇到，但只把它當成 wrangler dev 記錄裡的雜訊（`docs/12_worker_backend.md` § Known fidelity gaps），把 `exists` 改成不丟例外；沒處理成本 |
| `split`、`cp a b` 因為沒有檔案身分而失敗 | adapter 的 stat 沒有 `identity`、沒有 `createExclusive`，用他們鎖定的 3.2.0 實測一樣失敗；issue 和測試裡都沒有 |
| `chmod`、執行腳本 | 他們的儲存本來就有權限位元和 symlink，沒有這個問題 |
| 10 萬的迭代上限 | 只設了 `maxOutputSize`（1 MiB），其他用預設，所以 awk、cut、`seq` 在 10 萬行停下的問題也在；沒有相關 issue |
| gzip | workerd 有 `node:zlib`，不用替身 |
| just-bash 本身的差異（`jq unique`、`@csv`、`od -t`、`trap`、`xargs -I`、`$( )` 裡遞迴） | 沒有 issue、PR 或文件提到；測試只驗 adapter 和接線（讀寫、`mv`、輸出截斷、exit code），沒有和 GNU bash 對照 |

他們文件記下的差異只有：輸出不串流（整段結束才回來）、沒有 hard link 和 `utimes`、不能重新接上執行中的指令、`$PATH` 探查的記錄雜訊。給模型的 skill（`examples/worker-shell/src/skills/exec/SKILL.md`）寫的是「管線、變數、迴圈、函式和 bash 一樣」「`xargs` 等常用工具都有」，沒有提到上面這些差異。

### 他們有沒有回報上游

沒有。cloudflare/computer 的貢獻者（aron-cf、mattzcarey、ndisidore、ghostwriternr、scuffi、Caio-Nogueira、cjol）在 vercel-labs/just-bash 沒有開過 issue 或 PR；Cloudflare 組織和這些人也沒有 fork（288 個 fork 裡唯一叫 cloudflare-computer 的是 soonee-ai 的，沒有自己的 commit）。他們直接用 npm 上的 just-bash，沒有 patch，差異全靠 `adapter.ts` 在外面補。

上游很活躍（667 個 issue 和 PR，多半來自社群；最新版 3.6.0 在 2026-10-01），我們找到的有一部分已經有人報：

| 我們的發現 | 上游 |
|---|---|
| `> /dev/null` 寫進檔案系統 | #558 已關，修正 #562 在 2026-10-13 合併，還沒發版 |
| `$(( ))` 裡呼叫函式找不到 | #610 開著 |
| `xargs -I{}` | #466 開著，修正 #536 還沒合併 |
| `awk -f` | #468 開著 |
| awk `printf` 補零 | #608 開著 |
| 執行上限、上限設成無限會壞 | #599、#612 開著 |
| `printf` 的位元組跳脫 | #553 開著（UTF-8 的部分） |
| 瀏覽器版引入 `node:zlib` | #510、#526 開著 |

沒人報過的：`jq unique` 不排序、`@csv` 不加引號、`od -t x1`、`trap`、`date -d` 的相對日期、`sort -g`、`head -n -N`、沒有檔案身分時 `split` 和 `cp` 失敗、`yes` 到上限默默停下。

## git 和 gh（2026-10-24，S24）

- `git` 是 [just-git](https://github.com/blindmansion/just-git) 1.10.0（MIT，純 TypeScript，沒有相依套件，壓縮用 WebView 的 `CompressionStream`），第一次用到時才載入。38 個子指令，對照 git 2.55 做隨機測試；沒有 `rev-list`、submodule、LFS、SSH 遠端。
- 資料夾不支援 symlink，所以交給 just-git 的檔案系統拿掉 `symlink`／`readlink`：repo 裡的 symlink 會寫成內容是目標路徑的一般檔案（同 `core.symlinks=false`）。
- commit 類的子指令（commit、merge、rebase、cherry-pick、revert、tag、stash、pull）先問 GitHub `/user`，作者用 `名字 <id+login@users.noreply.github.com>`；沒有 token 時照 git 的規則（`git config user.name`）。
- `gh` 是自己寫的子集（`files/gh-command.ts`）：`api`（`-X`、`-f`、`-F`、`-H`、`--jq`、`--paginate`、`--input`、`graphql`）、`pr list/view/create/diff/checkout/comment/merge/close/reopen`、`issue list/view/create/comment/close/reopen`、`repo clone/view`、`search issues/prs`（跨 GitHub，`--repo`、`--owner`、`--state`、`--author`、`--label`）、`auth status`。`--json` 的欄位照 gh 的名字（`headRefName`、`author.login`…），`--jq` 交給 just-bash 的 jq。沒做的子指令和旗標回錯誤，叫模型改用 `gh api`。

| 操作 | 時間 |
|---|---|
| `git clone --depth 1` octocat/Hello-World | 1.3 秒 |
| `git clone --depth 1` jqlang/jq（436 個檔案） | 6.5 秒 |
| `git clone` geminixiang/pi-mobile 全部歷史（481 個檔案） | 6.8 秒 |
| `gh pr list -R cli/cli -L 3` | 0.5 秒 |
| 私有 repo：clone、開分支、commit、push、刪遠端分支 | 0.8 + 2.3 + 1.9 秒 |
| `gh search issues symlink --repo vercel-labs/just-bash` | 0.8 秒 |
| `gh issue create`、`comment`、`close` | 3.4 秒 |
| 開 base 和 head 分支、commit、push、`gh pr create` | 5.8 秒 |
| `gh pr view`、`gh pr diff`、`gh pr merge --squash` | 5.9 秒 |

模型（GPT 6.1 Sol）用一般的問法：「把 octocat/Hello-World 抓下來，README 寫了什麼、最後一個 commit 是誰」用 git；「cli/cli 最近三個 open 的 PR」先試 `gh pr list --search`（當時沒有，之後補上），失敗後改用 `gh api`；「我 pi-mobile 的 issue 2 在講什麼」用 `gh api` 讀 issue 和留言。三題都答對。
