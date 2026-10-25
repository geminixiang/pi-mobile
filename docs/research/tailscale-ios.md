# Tailscale 在 iPhone、iPad 上：怎麼讓連線好用

2026-10-25。iOS 的 ATS 擋明文 HTTP，pi 在 iOS 上只能用 Tailscale 名稱連模型閘道和電腦（`docs/design/platforms.md`）。這份整理 Tailscale 有哪些功能能讓這件事更順，每一項標出是查文件還是實測。實測用的是 iPad Air 5（iPadOS 26.7）上的 pi，連這台 Mac mini（Tailscale 1.102.4）。

## 現在的狀況（實測）

| 網址 | iPad 上的 pi |
|---|---|
| `http://100.64.0.1:4790` | ATS 擋（-1022），pi 會說要改填名稱 |
| `http://mac.tailnet.ts.net:4790` | 通（`Info.plist` 放行 `ts.net`） |
| `http://mac:4790`（短名稱） | 通（`NSAllowsLocalNetworking` 放行沒有網域的名稱） |
| `https://mac.tailnet.ts.net/`（這台 Mac 已有的 Tailscale Serve） | 通，不需要任何 ATS 例外 |

- iPad 到 Mac 走 DERP 中繼（香港），`tailscale ping` 144 ms，沒有直連。
- 這個 tailnet 已經開了 HTTPS 憑證：`status --json` 的 `CertDomains` 有這台 Mac 的名稱，`serve status` 有一個 `https://…ts.net` → `127.0.0.1:7317`。

## 1. MagicDNS 短名稱

- iOS 上 Tailscale 連著、「Use Tailscale DNS Settings」開著時，短名稱（`server`）會解析成 `server.<tailnet>.ts.net`：MagicDNS 把 tailnet 網域放在搜尋網域的第一個。分享進來的裝置要用完整名稱。（[MagicDNS](https://tailscale.com/docs/features/magicdns)）
- 有 iOS 使用者回報短名稱失效，完整名稱正常（[tailscale#12320](https://github.com/tailscale/tailscale/issues/12320)）；實測這台 iPad 兩種都通。
- **對 pi**：電腦清單存的是完整名稱（`/peers` 的 `dnsName`），不受影響。手動輸入時，短名稱和完整名稱都可以。

## 2. Tailscale Serve：在 tailnet 裡提供 HTTPS

- `tailscale serve --bg <port>` 把本機的 HTTP 服務放到 `https://<裝置>.<tailnet>.ts.net`，憑證由 Tailscale 自動申請和更新；後端照樣是 HTTP。`--https=<port>` 指定外面看到的 port。只有 tailnet 裡連得到，公開要用 Funnel。（[Serve](https://tailscale.com/docs/features/tailscale-serve)、[CLI serve](https://tailscale.com/docs/reference/tailscale-cli/serve)）
- WebSocket 客戶端改用 `wss://` 連同一個網址。有回報指出客戶端用 HTTP/2 握手時會失敗（426），HTTP/1.1 正常（[tailscale#20882](https://github.com/tailscale/tailscale/issues/20882)）；WKWebView 的 WebSocket 是 HTTP/1.1，要實測。
- **前提**：tailnet 後台要開 MagicDNS 和 HTTPS 憑證。申請過憑證的機器名稱會出現在公開的 Certificate Transparency 紀錄裡，但不會因此被外面連到；只有申請過的機器會出現。（[Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)）這台 Mac 的名稱已經在裡面了。
- **身分 header**：Serve 轉給後端的請求帶 `Tailscale-User-Login`、`Tailscale-User-Name`，並刪掉客戶端自己帶的同名 header；加了 tag 的裝置沒有。後端要只聽 localhost，否則可以繞過 Serve 偽造。（[Serve › Identity headers](https://tailscale.com/docs/features/tailscale-serve)）

**對 pi 的意義**

- **模型閘道**：使用者在閘道那台機器跑一次 `tailscale serve --bg --https=<port> http://127.0.0.1:8317`，pi 填 `https://…ts.net:<port>`。好處：
  - iOS 不用 ATS 例外。
  - 金鑰改走 https，不再靠 `refuseCleartextSecret` 放行 Tailscale 網段的 http。
  - 網頁版也能連：https 的網頁不能呼叫 http 的網址（mixed content）。
- **電腦端**：`pi-mobile serve` 可以改成只聽 localhost，由 Serve 提供 `https://…ts.net:<port>`，身分改看 `Tailscale-User-Login`，不用再呼叫 whois。好處同上，網頁版也能連電腦。代價：
  - 要改電腦端的設計。
  - 使用者的 tailnet 要開 HTTPS。
  - 機器名稱會進公開紀錄。
  - 配對機制照樣要留：header 證明的是哪個使用者，不是哪個 app。

## 3. iOS 上 Tailscale 有沒有開

- 第三方 app 看不到別的 app 的 VPN 狀態。pi 只能從連線失敗推測，錯誤訊息已經寫「電腦要開著、連上 Tailscale」。
- Tailscale iOS app 有 **VPN On Demand**：Wi‑Fi、行動網路各自可以設「Always」，有網路就自動連上。（[VPN On Demand](https://tailscale.com/docs/features/client/ios-vpn-on-demand)）
- Tailscale 也提供捷徑動作：Connect、Disconnect、Toggle、Get Status，從 1.50 起改用 App Intents。（[Shortcuts](https://tailscale.com/docs/features/mac-ios-shortcuts)）
- **對 pi**：建議使用者開 VPN On Demand，這樣 pi 要用的時候 Tailscale 一定連著。可以寫進連不上時的錯誤訊息。

## 4. 把 Tailscale 直接放進 app：TailscaleKit

- `libtailscale` 把 tsnet（Go）編成 C 函式庫，`swift/` 底下的 TailscaleKit 是 Swift 包裝。app 自己變成一個 tailnet 節點，完全在 userspace，不是整台裝置的 VPN；它提供 `URLSession` 擴充，用來對 tailnet 發請求。（[libtailscale](https://github.com/tailscale/libtailscale)、[TailscaleKit README](https://github.com/tailscale/libtailscale/blob/main/swift/README.md)、[tsnet](https://tailscale.com/docs/features/tsnet)）
- 要用 Go 和 Xcode 建置成 `TailscaleKit.xcframework`，嵌進 app 時簽章。2026-10 仍在更新：binding 版本 0.2.0。
- **對 pi**：好處是不用另外裝 Tailscale app，也不跟其他 VPN 互搶（iOS 同時只能開一個 VPN）。代價很大：
  - app 會是 tailnet 裡另一台裝置，要另外登入。
  - 所有 tailnet 流量都要改走原生的 `URLSession`，不能用 WebView 的 `fetch` 和 WebSocket。
  - 要多一套 Go 建置。
  - Android 要另外接一次。
  
  **現在不值得**，記下來當作以後的選項。

## 5. 延遲：中繼

- 沒辦法直連時，Tailscale 先試 tailnet 裡的 **peer relay**，最後才用 DERP。Peer relay 要 Tailscale 1.86 以上，要一個連得到的 UDP port，並在 grants 裡設定。（[Peer relays](https://tailscale.com/docs/features/peer-relay)）
- **對 pi**：iPad 走 DERP 香港要 144 ms，每個請求都多這一段，但對話是串流，影響不大。這是使用者 tailnet 的設定，pi 不用處理。

## 建議

| 做法 | 改什麼 | 成本 | 效果 |
|---|---|---|---|
| A. 連不上時的錯誤訊息提到 Tailscale app 的 VPN On Demand | 一句文案 | 很小 | 少掉「Tailscale 沒開」這種失敗 |
| B. 模型閘道建議用 Tailscale Serve 的 https 網址 | 文件、設定頁提示 | 小，使用者要跑一行指令 | iOS 和網頁版都能用，金鑰走 https |
| C. 電腦端改由 Tailscale Serve 提供 https/wss | `host/` 的監聽和身分檢查、安裝腳本 | 中 | 網頁版也能連電腦；iOS 不靠 ATS 例外 |
| D. TailscaleKit 放進 app | 原生網路層、建置 | 大 | 不用裝 Tailscale app |
