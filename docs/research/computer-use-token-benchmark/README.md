# Computer-use MCP token benchmark

2026-10-24。**實際 GUI 任務 30 次已完成**，schema microbenchmark 也已完成。

## 實際任務結果

同一模型路由、三個多步驟合成 GUI workflow、每題每組五次：

| | pi-mobile MCP | computer-use-mcp 1.8.0 |
|---|---:|---:|
| 累計 input + output（含快取） | 1,484,263 | 4,812,272 |
| 成功 | 14/15 | 15/15 |

總 tokens 少 **69.2%**；只看兩邊都成功的 14 組配對，總 tokens 少 **68.4%**。未快取 input 只少 **30.0%**，不能把總 token 比例當帳單比例。

- **完整報告：[RESULTS.md](RESULTS.md)**
- **後續定點修補：[repair/README.md](repair/README.md)**（不混入這 30 筆，也不替換原本失敗）
- **方法與限制：[PROTOCOL.md](PROTOCOL.md)**
- **發文草稿：[X-draft.md](X-draft.md)**
- `task-results.json`、`runs/`：逐次 usage、工具軌跡、完整 state oracle 與最後畫面。
- `direct.mjs`、`server.mjs`、`fixture.html`：實際執行程式與隔離治具。
- `verify.mjs`、`summarize.mjs`：重新驗證與彙整已保存結果，不呼叫模型。

這不是通用 computer-use 排名：單模型路由、特製表單任務、每格五次。包含一筆真實失敗，沒有刪掉或補跑。手機 app 的兩次 code-mode 圖片遺失預檢另存，不算進這 30 次。

## 固定版本

- pi-mobile binary 的來源 HEAD：`21b3ebdd107a6e77c3b250f8c2a037c1569be898`，建置時 host 工作樹沒有改動。
- Binary SHA-256：`9c96130fa2beffbd145ef0f297a43ed6d040cf3d4e953c1cd3f2d9d76b66bcd1`。serverInfo.version 為 dev，故以來源／hash 定位。
- 對照：[domdomegg/computer-use-mcp](https://github.com/domdomegg/computer-use-mcp)，npm **1.8.0**。
- npm integrity：`sha512-C0Qrcztq7Dh6SyTUGjqG667EGewa2uXIUKBXI5HGpa84+PBjgjqW51TATFMzrXIFGRcvt3qUHD+2CbF/js4ykg==`。
- 對方 serverInfo.version 回報 1.0.0，版本改以 package.json／npm lockfile 為準。
- 查核時 GitHub [latest release](https://github.com/domdomegg/computer-use-mcp/releases/latest) 亦為 v1.8.0；實驗仍固定 npm 版本，不使用浮動 latest。
- 模型路由、OS、Node 與原始碼 SHA-256 見 `manifest.json`。

## Schema microbenchmark：獨立結果

兩邊實際啟動 server，使用相同 client 做 initialize／tools/list。先從 S24 MCP client 取得一次，再用 Mac stdio client 獨立取得；canonical JSON hashes 相同。

| 計量面／tokenizer | 對照 1.8.0 | pi-mobile | 減少 |
|---|---:|---:|---:|
| MCP tools/list／o200k_base | 899 | 404 | 55.1% |
| MCP tools/list／cl100k_base | 893 | 382 | 57.2% |
| OpenAI function JSON／o200k_base | 880 | 390 | 55.7% |
| OpenAI function JSON／cl100k_base | 878 | 374 | 57.4% |

pi-mobile 是 screenshot、act 兩個工具，對照是 computer 一個工具。工具數不等於文字 token 成本。

### 計量邊界

- tiktoken 0.14.0，本地確定性 tokenization，不使用字元數估算。
- Canonical JSON：UTF-8、保留 Unicode、排序 keys、移除分隔空白。
- MCP 面為 `{"tools":[完整工具物件]}`，包含 annotations，不包括 JSON-RPC envelope 和 server instructions。
- OpenAI 面為 `type:function`、`function:{name,description,parameters}`；不補 strict 欄位，也不代表供應商內部模板。
- 這不是 API usage 或每次請求帳單，不包含圖片，不宣稱兩個 tokenizer 等於 GPT 6.1 或 Claude 的 tokenizer。
- 功能並不完全相同，schema 較小不代表能力較強。

### 重跑 schema

在此資料夾執行；capture 會覆寫相應 JSON。也可只對附帶 schema 跑 count.py：

```sh
python3 -m venv .venv
.venv/bin/pip install tiktoken==0.14.0
node capture.mjs own /path/to/pi-mobile mcp computer
node capture.mjs upstream npx -y computer-use-mcp@1.8.0
.venv/bin/python count.py
```

`own.tools.json`、`upstream.tools.json` 是實際回傳；`schema-results.json` 包含原始數字和 hashes。

## 重跑 GUI

需要隔離的可見 macOS Chrome、1920×1080 主螢幕、已授權的 pi-mobile host、兩個固定版本 MCP，以及自己的模型 API credential。程式的 host／command 路徑請依環境調整，不要將金鑰存入 repo。

```sh
node server.mjs
```

另開 terminal，使用全新的測試 profile，勿指向個人 Chrome profile：

```sh
open -na 'Google Chrome' --args \
  --user-data-dir=/tmp/computer-use-benchmark-profile \
  --remote-debugging-port=9444 \
  --no-first-run --no-default-browser-check --disable-sync --disable-extensions \
  --window-position=0,25 --window-size=1920,990 \
  http://127.0.0.1:47881/
RUN_PREFIX=new-experiment REPEATS=5 node direct.mjs
```

`direct.mjs` 使用既有本機 CLIProxyAPI 設定檔；請先核對自己的 endpoint 與憑證。實驗會真的花模型 tokens，並持續操作專用桌面視窗。使用新的 RUN_PREFIX 避免覆寫已保存結果。驗證器目前固定核對本批 `direct-pilot-*`／`confirm-*` 的 30 次結果。

原本的 TextEdit 系統權限問題已透過**改用本機 GUI 治具**避開，沒有代替使用者允許 OS 授權，也沒有繞過 TCC。另發現的手機圖片遺失問題有紀錄，但沒有在這次 benchmark 中修改產品實作。
