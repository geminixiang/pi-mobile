# 四個桌面上的原生 app computer use

2026-11-11。pi-mobile host 是 `main` 的 c873d6c，加上這次量測找到、一起修掉的問題；模型 `gpt-6.1-sol`，走跟 [10-24 的 benchmark](../computer-use-token-benchmark/README.md) 相同的 CLIProxyAPI 路由，reasoning effort low。每個桌面三題各跑五次，一個桌面 15 次，總共 60 次。螢幕都是 1920×1080。

網頁該交給走 CDP 的瀏覽器，不該靠截圖和點擊，所以題目用每個桌面都內建的 app：文字編輯器和檔案管理員。判分直接讀檔案系統，不看 app。

## 題目

| 題目 | 開始時 | 要做的事 |
|---|---|---|
| `editor` | 編輯器開著 `note.txt`（`alpha beta gamma` 加一個換行） | 把 `beta` 改成 `BETA`，最後加兩行中英混合的文字，存檔 |
| `files` | 檔案管理員開著 `files` 資料夾 | 建「封存」資料夾，搬三個檔案進去，把其中一個改名；`備忘.txt` 留在原處 |
| `crossapp` | 檔案管理員開著 `inbox`（四個子資料夾），編輯器開著空的 `list.txt` | 把每個資料夾的名稱寫進 `list.txt`，一行一個，存檔 |

| 桌面 | 編輯器 | 檔案管理員 | 怎麼跑的 |
|---|---|---|---|
| macOS | TextEdit | Finder | 在 Mac 上，從終端機直接啟動 host |
| Windows 11（中文版、注音） | 記事本 | 檔案總管 | 經 tailnet 上的 pi-mobile host |
| Linux X11 | GNOME 文字編輯器 | Nautilus | Docker 裡的 Debian trixie，Xvfb + openbox，以 root 執行 |
| Linux Wayland | GNOME 文字編輯器 | Nautilus | Docker 裡的 Debian trixie，無頭的 GNOME 48，以 root 執行 |

## 結果

| 桌面 | 成功 | 總 tokens | 未快取輸入 | 每次中位數 | 中位秒數 | 中位模型呼叫 |
|---|---:|---:|---:|---:|---:|---:|
| macOS | 12/15 | 493,943 | 197,950 | 9,840 | 23 | 4 |
| Windows 11 | 11/15 | 386,516 | 161,611 | 15,355 | 34 | 5 |
| Linux X11 | 14/15 | 296,907 | 157,687 | 15,410 | 32 | 5 |
| Linux Wayland | 15/15 | 270,642 | 161,195 | 14,749 | 33 | 5 |

每題的中位數（總 tokens；括號裡是成功次數、中位模型呼叫）：

| 題目 | macOS | Windows 11 | Linux X11 | Linux Wayland |
|---|---:|---:|---:|---:|
| editor | 9,720（3/5，4） | 5,621（1/5，3） | 9,796（5/5，4） | 9,679（5/5，4） |
| files | 87,352（4/5，12） | 39,960（5/5，8） | 38,599（4/5，8） | 29,338（5/5，7） |
| crossapp | 9,407（5/5，4） | 15,355（5/5，5） | 15,410（5/5，5） | 14,749（5/5，5） |

- 編輯器和跨 app 兩題，四個桌面花的差不多。檔案管理員那題 Finder 貴一倍：要 12 次模型呼叫，Nautilus 是 7–8 次。
- 8 次失敗裡有 6 次是同一個錯：TextEdit 和記事本會把檔案結尾的換行顯示成一行空行，模型按 ctrl+end 後又打了換行，檔案多一行空白。GNOME 文字編輯器不顯示那一行，所以 Linux 沒碰到。模型沒看截圖就說完成了。不計這個錯的話，macOS 是 14/15、Windows 15/15；判分維持嚴格。
- 另外兩次：macOS 上模型在 Finder 把 `合約.txt` 改成 `合約.txt.txt`；X11 上 Nautilus 做到一半當掉（容器裡以 root 執行）。
- 沒有一次失敗是 host 做了模型沒要求的事。

## 量測時找到的 host 問題

已經在同一個改動修掉，見 [docs/tools.md](../../tools.md) 2026-11-11 那一列：

1. Wayland：剪貼簿是空的時候去讀，xdg-desktop-portal-gnome 48 會當掉，之後到重新登入前 portal 都不給剪貼簿（`Invalid state`），中文打不進去。portal 會丟掉工作階段開始時 mutter 報的擁有者，所以 host 改成只有 `SelectionOwnerChanged` 說別人擁有文字時才讀。
2. Windows：螢幕閒置關掉後，截圖拿到的是關掉前最後一張畫面。現在閒置超過 30 秒，截圖前先叫醒螢幕。
3. 點擊不能按住修飾鍵，cmd／ctrl 多選做不到，模型只好一個一個搬。現在 `click` 可以帶 `keys`。
4. `cmd++`、`cmd+plus` 都是「沒有這個按鍵」。

## 重跑

```sh
PLATFORM=mac BENCH_MCP="/path/to/pi-mobile mcp computer" RUN_PREFIX=mac REPEATS=5 node run.js
PLATFORM=windows BENCH_HOST=<電腦> BENCH_KEY=<配對 key> BENCH_MCP="pi-mobile mcp computer" RUN_PREFIX=windows REPEATS=5 node run.js
PLATFORM=x11 BENCH_SHELL="docker exec -i <容器> bash -s" BENCH_MCP="docker exec -i <容器> sh -c '. /work/env.sh; exec /work/pi-mobile mcp computer'" RUN_PREFIX=x11 REPEATS=5 node run.js
```

- `BENCH_SHELL` 在桌面上跑重設和判分：預設是 `bash -s`，有 `BENCH_HOST` 時走 host 的 `/exec`。
- `BENCH_MCP` 是啟動 MCP server 的指令。
- Linux 需要 `/work/env.sh` 匯出 `DISPLAY`（或 Wayland 的變數）和 session bus。Wayland 要先在遠端桌面的對話框按一次允許，host 才會記住 token。
- 模型的 key 從 `~/.pi/agent/cliproxyapi.json` 讀。會真的花 tokens，也會接管桌面。

每次重設做的事：
- macOS：結束 TextEdit，關掉 Finder 視窗（cmd+alt+w），隱藏其他 app（cmd+alt+h）。終端機沒有 Apple Event 的自動化權限，所以這些都透過 MCP 按鍵。
- Windows：跑之前先備份記事本的 `TabState` 和 `WindowState`（在 `%LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState`）。每次重設清空它們，讓記事本全新開啟，縮小所有視窗，再把題目的視窗叫到前面。跑完把備份放回去，使用者的分頁就會回來。
- Wayland：先放一段文字進剪貼簿，避開修好前的問題 1。

`runs/` 存每次的用量、工具軌跡、前後的檔案系統和預期結果。macOS 和 Windows 的截圖不放進 repo，因為拍到的是真的桌面。

## 限制

一個模型、每格五次、三題都挑能用檔案判分的。Linux 在容器裡以 root 執行、介面是英文；macOS 和 Windows 是真的桌面、介面是中文。秒數包含模型時間，也沒有隔離其他負載。
