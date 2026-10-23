# 手機資料夾的 bash（just-bash）實測

2026-10-23，S24，just-bash 3.6.0。Bot 沒有連電腦時，`bash` 跑在手機上的 just-bash（TypeScript 寫的 bash，跑在 Web Worker），檔案操作經主執行緒交給 `BotFilesPlugin.java`。

## 怎麼測

- `test/bash/cases.json`：136 個情境，涵蓋語法（參數展開、陣列、函式、here-doc、process substitution、glob、`set -e`、`pipefail`）、coreutils、grep/rg、sed、awk、jq、中文與奇怪的檔名、CRLF、二進位、模型常寫的管線。
- `test/bash/gnu.sh` 在 Debian 13（bash 5.2、GNU coreutils、gawk、jq 1.7）跑同一批情境，產生 `gnu.json`。
- `CDP_PORT=… node test/bash/run.ts` 在手機上開一個暫時的 Bot 跑一遍，和 GNU 比 stdout 與 exit code；不一樣但已知的差異記在 `accepted.json`，其他算回歸。跑完會刪掉那個 Bot。
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

## 安全

- `..`、`/../..`、絕對路徑都停在 Bot 自己的資料夾；碰不到別的 Bot 的資料夾，也碰不到 `/data`、`/sdcard`、`/etc`、`/proc`。
- 沒有 python、node、curl、wget、git、tar，也沒有網路。
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

## just-bash 本身的差異（`accepted.json`）

會默默給錯答案的，最需要注意：

- `jq unique` 不排序（`[3,1,2]` → `[3,1,2]`），`@csv` 不幫字串加引號。
- `od -t x1` 忽略格式，照樣印八進位。
- `printf '\xff' > f` 寫成 UTF-8 的兩個位元組：重導向依內容猜編碼，二進位資料寫不出來。
- `yes` 到迭代上限會默默停下。
- awk 的 `printf "%05.1f"` 不補零。
- `tree` 的目錄數算錯。

直接報錯的（模型看得到，會換別的寫法）：

- 不支援：`trap`、`xargs -I`、`head -n -N`、`sort -g`、`awk -f`、`grep -s`、`paste -s` 讀 stdin（要寫 `-`）、`date -d '… +1 day'`。
- 在 `$( )` 裡遞迴呼叫函式會找不到函式。

只是格式不同：`uniq -c` 的欄寬、`grep -r` 不加 `./`、`rg` 一律印行號、`ls` 和 `sort` 對中文用語系排序、`cut -c` 和 `wc -m` 以字元計算（GNU 以位元組計算）、背景工作 `&` 不會真的並行。

## 模型實際用起來

四個工作：帳目分類加總並找最大一筆、log 依模組和小時統計 ERROR、JSON 篩選加總存成 CSV、寫腳本依序改檔名並執行。GPT 6 Luna、Claude Haiku 5.5、GPT 6.1 Sol 各跑一次，12/12 答對，沒有一次卡在上面的差異。

說明裡原本只寫「沒有其他程式」，Luna 被要求「用 python 算」時會放棄；加上「沒有 python，用 awk 或 jq 算」之後，它改用程式模式算出正確答案。Haiku 本來就會改用 awk。
