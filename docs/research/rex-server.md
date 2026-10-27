# Rex server

2026-10-27。問題：Superlogical 的 Rex server 是什麼、怎麼讓別的裝置連進來、怎麼驗證身分，pi mobile 能不能直接用它，或從它學到什麼。來源是 Rex 官方文件（每頁加 `.md` 就是 Markdown，全部內容在 [llms-full.txt](https://www.superlogical.com/rex/docs/llms-full.txt)）。

## Rex 是什麼

- Superlogical 做的「multiplexer for all work」，第一步是終端機 multiplexer：session 留在 server 上，關掉 app、換一台裝置接回來，畫面還在。創辦人之一是 Mitchell Hashimoto（Ghostty、HashiCorp）。[superlogical.com](https://www.superlogical.com/)
- 名詞：**session**（一組工作）、**window**（session 裡的分頁）、**block**（分頁裡的一個應用，目前就是終端機）、**client**（連到 server 的程式，例如 app）。ID 固定不重用，也可以加 label。[The CLI](https://www.superlogical.com/rex/docs/automate/cli)
- 現況：封閉 beta。macOS app（內含一個本機 server）開放給所有測試者；Linux server 只給 Linux 測試梯次，安裝要帶 `REX_PACKAGE_TOKEN`。Windows server、iOS/Linux/Windows client 已經有，但還沒開放測試。[Installation](https://www.superlogical.com/rex/docs/installation)、[Installing on Linux](https://www.superlogical.com/rex/docs/linux/installation)
- 沒有 telemetry；server 和 CLI 在預設設定下不對外連線。[Privacy](https://www.superlogical.com/rex/docs/reference/privacy)

## 三種 server 模式（Linux）

| 模式 | 適合 | 以誰的身分執行 | 由誰啟動 |
|---|---|---|---|
| Personal | 只有自己 | 自己的帳號 | 任何 `rex` 指令，或 `rex server start` |
| Shared | 幾個信得過、共用一個帳號的人 | `rex` 系統帳號 | `rex.service` |
| Login | 多人，各用自己的帳號 | 先 root，再切到各人帳號 | `rex-login-server.service` |

- Personal：被 `rex` 指令自動帶起來的 server，在最後一個 session 和連線關掉約 10 秒後自己結束；要常駐就明確執行 `rex server start`。socket 在 `$XDG_RUNTIME_DIR/rex`，log 和狀態在 `~/.local/state/rex`。
- Shared：`rex` 群組的成員都能連，看得到、也能輸入每個 session。套件升級會重啟服務，**所有 session 一起結束**。
- Login：最像 SSH，一個 root 服務依來源身分把人送進各自的帳號（經 PAM 開 login session）。各帳號的 server 在 login server 停止、重啟、升級時都繼續跑，session 不會斷。
- 三種模式預設都只聽本機 Unix socket。

來源：[Server Modes](https://www.superlogical.com/rex/docs/linux/server-modes)、[Shared Server](https://www.superlogical.com/rex/docs/linux/shared-server)、[Login Server](https://www.superlogical.com/rex/docs/linux/login-server)

## 遠端連線與身分

Rex 目前**只依「怎麼連進來」判斷是誰**，沒有自己的帳號、密碼或金鑰。官方說這是短期限制，之後會做完整的驗證與授權，包括支援現有 SSH key；在那之前建議用 Tailscale。

| Listener | 需要 | 能不能認出來源 |
|---|---|---|
| 內建 Tailscale（`--tailscale`） | Tailscale 帳號；電腦不必裝 Tailscale | 能 |
| Tailscale Serve（`--extra-listen tailnet-serve:///run/rex/serve.sock`） | 電腦上的 Tailscale | 能（tagged 裝置除外） |
| Tailnet 位址（`--extra-listen tailnet://:7297`） | 電腦上的 Tailscale | 能 |
| 純 HTTP（`--extra-listen :7297 --allow-anonymous`） | — | 不能，每個連線都有完整權限 |

- 內建 Tailscale 用 tsnet 讓 server 自己成為 tailnet 裡的一台裝置，預設叫 `rex`（`--tailscale-hostname` 可改），網址 `https://rex.<tailnet>.ts.net`，tailnet 要開 MagicDNS 和 HTTPS 憑證。第一次的登入連結在 `rex server status`，或用 `--tailscale-auth-key-file` 給一次性 auth key。
- **一個連線能做 server 能做的所有事**，包括以它的帳號啟動程式。預設只放行擁有這台機器（或這個 Rex 裝置）的 Tailscale 使用者；要放其他人進來得加 `--tailscale-allow-tailnet-members` 或 `--tailnet-allow-identified`。tagged 裝置沒有擁有者，一定要加其中一個選項才進得來。
- Login server 用 `/etc/rex/accounts.jsonc` 決定誰能用哪個帳號，principal 可以是 `tailscale:alice@example.com`、`tailscale:tag:ci`、`peer:1000`（本機 uid）、`identified`、`anonymous`；`anonymous` 永遠不能用 root。
- `rex client ls` 的 `principal` 欄顯示每個連線的身分。
- Client 端：Mac app 選 **Add Remote Host…**；CLI 用 `rex -S https://build.example.ts.net ls`，或 `rex hosts add`（目前只存在 CLI，不會同步到 app）。只給主機名時依序試 HTTPS 443、HTTPS 7297、HTTP 7297。

來源：[Remote Access](https://www.superlogical.com/rex/docs/linux/remote-access)、[Login Server](https://www.superlogical.com/rex/docs/linux/login-server)

## 能程式化的部分

- **Server API 自帶說明**：`rex api list`、`rex api describe <method>`、`rex api call <method> '<json>'`；`--json` 輸出每個方法的 `input_schema`、`output_schema`（JSON Schema）、範例和驗證說明，內容來自連上的那台 server，所以永遠跟它的版本一致。CLI 和 Lua API 都由它動態產生。block 也有自己的方法，例如 `com.superlogical.terminal.format` 讀終端機畫面。[Server API](https://www.superlogical.com/rex/docs/automate/server-api)
- **事件**：視窗開啟、目錄改變、程式結束、session 銷毀等，Lua 用 `rex.on`、`rex.wait` 接，CLI 用 `rex events` 串流。[Events](https://www.superlogical.com/rex/docs/reference/events)、[Lua Events](https://www.superlogical.com/rex/docs/automate/lua-events)
- **Agent skill**：`rex skill setup` 會替找到的 agent 裝 skill，pi 的 skill 在 `~/.agents/skills/rex`；pi 不支援它的 hook（只有 Claude Code、Codex 支援）。agent 靠終端機裡的 `REX_SESSION`、`REX_BLOCK` 知道自己在哪。[Agents](https://www.superlogical.com/rex/docs/automate/agent-skill)
- **Program Status Protocol（OSC 7501）**：一個通用的終端機跳脫序列，讓程式回報 `idle`、working、`blocked`（等使用者，可帶 `kind=permission`）、完成或失敗，以及原因（`msg` 用 base64）。Rex 用它在 session 列表和分頁標頭顯示狀態，官方也計畫拿它推播到行動 app。[Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)

**文件沒有公開 client 和 server 之間的線上協定**；能用的介面只有 `rex` CLI、Lua 和 `rex api call`。

## 對 pi mobile 的意義

- **不能拿來當連線層**：封閉 beta、要 package token，client 協定也沒公開，所以 Android app 沒辦法直接當 Rex client。要碰 Rex，只能在電腦上透過 `rex` CLI，例如讓 agent 在電腦上執行 `rex capture`、`rex send`。
- **連線方式已經借鏡過**：[connecting-computers.md](connecting-computers.md) 的 B 案就是 Rex 的做法，[design/computer-host.md](../design/computer-host.md) 的 `pi-mobile serve` 也照 `rex server` 命名。差別在於 pi-mobile 比 Rex 多一層：Tailscale 只證明「哪台裝置」，手機上其他 app 經同一個 VPN 也連得到，所以 pi-mobile 另外要配對金鑰。Rex 文件沒有處理這個情況；它把「能連到就是那個人」當成目前的已知限制。
- **升級不斷 session**：Rex 的 shared server 一升級就結束所有 session，login server 則讓各帳號的 server 留著舊版直到 session 結束。pi-mobile 的 daemon 由手機帶過去，`pi-mobile serve` 升級時保留中的 session 會怎樣，值得照這個角度檢查一次。
- **決定（2026-10-27）**：網路與資安照 Rex 的選擇，交給 Tailscale，不自己做 TLS，也不改用 WireGuard。見 [design/computer-host.md](../design/computer-host.md) § 網路與資安。
- **OSC 7501 可以考慮**：如果電腦上的長指令（或 pi 本身）輸出 OSC 7501，pi mobile 的 `/exec` 串流就能用一個公開格式，不靠解析畫面就知道「在等使用者」或「已完成」。目前只有 Rex 實作，採用前要先確認 pi 或常用工具會不會輸出它。
