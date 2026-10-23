# Tailscale：`pi-mobile serve` 怎麼拿它當驗證

2026-10-23。`pi-mobile serve` 不用密碼、金鑰或 SSH，只靠 Tailscale：它只聽這台電腦的 Tailscale IPv4 位址，每個請求都用 `tailscale whois` 確認對方是同一個 Tailscale 使用者的裝置（`host/main.go` 的 `owner`、`guard`）。這份整理這件事依賴的 Tailscale 行為，以及它的邊界。原始碼出處是 [tailscale/tailscale](https://github.com/tailscale/tailscale)。

## `whois` 回什麼

- LocalAPI 的 `WhoIsResponse` 只有三個欄位：`Node`、`UserProfile`、`CapMap`（`client/tailscale/apitype/apitype.go:35`）。
- **實測**（Mac mini 查 S24）：
  - `Node` 有 `ID`、`StableID`、`Name`、`User`、`Addresses`、`Hostinfo`、`Online`、`KeyExpiry` 等欄位。
  - `UserProfile` 只有 `ID`、`LoginName`、`DisplayName`（另外還有頭像網址）。
- `tailcfg.Node`（`tailcfg/tailcfg.go`）：
  - `User` 是**建立**這個節點的使用者。用了 ACL tag 的節點，這個欄位不代表它實際的身分。（:381–384）
  - `Sharer`：節點是別人分享進來的時候，分享者的 user id。（:386–387）
  - `Tags`：節點的 tag，例如 `tag:prod`。（:434–437）
- **加了 tag 的裝置沒有使用者身分**：它的身分就是那組 tag。`whois` 對它回傳的 `LoginName` 是虛構的 `tagged-devices`，不能當成真人。（[tailscale#4605](https://github.com/tailscale/tailscale/issues/4605)）
- 我們的判斷，也就是 `owner()` 的規則：
  - `Node.Tags` 非空就拒絕。
  - `UserProfile.ID` 跟本機 `status --json` 的 `Self.UserID` 不同就拒絕。

## 分享進來和分享出去的裝置

- **分享**是把一台機器開放給另一個 tailnet 的特定人；被分享的一方看不到原 tailnet 的 tag。（[Sharing](https://tailscale.com/kb/1084/sharing)）
- **別人分享進我 tailnet 的裝置**：它的使用者是對方，跟我的 user id 不同，會被拒絕。
- **我把 Mac 分享給朋友**：朋友的裝置連得到這台 Mac，但它的使用者是朋友，一樣會被拒絕。
- 所以 user id 這一關擋住了分享。不過 Tailscale 的存取規則本身是放行的：`"src": ["*"]` 也包含被分享的人。（[Grants examples](https://tailscale.com/docs/reference/examples/grants)）

## 存取規則（ACL／grants）的預設

- 新 tailnet 預設是「全部互通」：`{"src": ["*"], "dst": ["*"], "ip": ["*"]}`。（[Grants examples](https://tailscale.com/docs/reference/examples/grants)）
- 所以預設下，tailnet 裡**任何成員**的裝置都連得到 4790 port。擋人的是我們的 whois 檢查，不是 Tailscale 的規則。
- Personal 方案可以有其他成員。他們的裝置連得到 port，但 user id 不同，會被拒絕。

## 這台電腦怎麼找到 `tailscale`

- macOS 有兩種 Tailscale app，都附 CLI（[macOS variants](https://tailscale.com/docs/concepts/macos-variants)、[CLI](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)）：
  - **Standalone**：在 app 的設定裡安裝 CLI 後，有 `/usr/local/bin/tailscale`。
  - **App Store 版**：直接執行 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。
- **在腳本裡用時**：官方建議寫完整路徑；如果執行後打開的是 app 而不是 CLI，就設 **`TAILSCALE_BE_CLI=1`**。（[CLI](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)）
- **我們現在的做法跟官方不同**：
  - launchd 沒有 `TERM`，所以我們塞了 `TERM=dumb`，讓 app 的執行檔以為自己在終端機裡（`host/main.go` 的 `tailscaleJSON`）。這能用，但不是官方介面，應該改成 `TAILSCALE_BE_CLI=1`。
  - 路徑裡寫的是小寫 `tailscale`，實際檔名是 `Tailscale`。macOS 的檔案系統預設不分大小寫才剛好找得到，應該改成正確的大小寫。

## MagicDNS 和位址

- 電腦的 ID 用它的 MagicDNS 名稱（例：`geminixiangmac-mini.tail4f4249.ts.net`）；`status --json` 的 `Self.DNSName` 結尾有一個點，要去掉。
- `pi-mobile serve` 只綁 Tailscale 的 IPv4，所以區域網路、公共 Wi‑Fi 都連不到；Tailscale 重啟或位址改變時，它會重新綁定（`listen()`）。

## Android 看得到什麼

- **實測**：Android 版 Tailscale 是 VPN app，其他 app 只看到一個 VPN 網路介面，沒有 LocalAPI 可以呼叫，所以列不出 tailnet 裡的裝置，也查不了 `whois`。
- 這就是為什麼第一台電腦要手動輸入名稱，之後的電腦才由已加入的電腦用 `/peers` 列出來（`docs/design/computer-host.md`）。

## 拿 tailnet 當驗證的風險

| 情況 | 會怎樣 | 現在的對策 |
|---|---|---|
| 手機遺失或被別人拿去用 | 能進你 tailnet、登入你帳號的裝置都能操作電腦 | `docs/security.md` 寫了：到 Tailscale 後台移除那台裝置 |
| 你自己的另一台裝置中毒 | 它跟手機是同一個使用者，會被放行 | 無；這是信任模型的前提 |
| tailnet 的其他成員、被分享的人 | Tailscale 放行，但 user id 不同 | 我們拒絕 |
| 加了 tag 的裝置（例如伺服器） | 沒有使用者身分 | 我們拒絕 |
| 網頁從瀏覽器打 4790 | 有 `Origin` header | 只接受 app 的 WebView 的 Origin |
| `whois` 每個請求都要跑一次 CLI | 每次幾十毫秒 | 本機的 `status` 快取 10 秒；`whois` 沒有快取 |

## 對 pi-mobile 的結論

1. **改用官方的 `TAILSCALE_BE_CLI=1`**，路徑用正確的大小寫 `Tailscale`。
2. **whois 規則維持現狀**：拒絕有 tag 的裝置、只接受同一個 user id。這擋住了分享和其他成員，Tailscale 的預設規則擋不住這些。
3. **在設定或文件裡建議收緊 tailnet 規則**：例如只讓 `autogroup:member` 連到這台電腦的 4790，多一層保護。不強制。
4. **手機遺失時的處理**要放在電腦設定頁看得到的地方，不只寫在 security.md。
5. **之後可以改用 LocalAPI**（透過 unix socket 直接查 `whois`），不必每個請求都執行一次 CLI。等量測顯示 CLI 太慢再做。
