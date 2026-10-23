# 怎麼把一台電腦交給 pi mobile 操控

2026-10-22。問題：使用 pi mobile 的人，要怎麼最省事、又安全地，把自己 tailnet 裡的一台電腦（Mac 或 Linux）交給手機上的 agent 直接操作。

## 現在的做法

設定 › 電腦 › 新增：填主機、帳號、port → 讀主機金鑰 → 到電腦上跑 `ssh-keygen -lf …` 比對指紋 → 接受 → 把手機顯示的 `echo '<公鑰>' >> ~/.ssh/authorized_keys` 搬到電腦上執行 → 回手機按「安裝並連線」（上傳 pi-env；有容器引擎時再建 image）→ 選容器或直接。切到容器之後還要再按一次「重新安裝」。

手機和電腦之間要來回好幾趟，還得把一長串公鑰搬到電腦上，對沒用過 SSH 的人太難。另外，手機只會用公鑰登入（`SshPlugin.java` 只呼叫 `authenticateWithPublicKey`），私鑰以明文存在 app 的 `files/ssh`。

## 別人怎麼做

| 產品 | 連線方式 | 電腦上要做什麼 | 手機上要做什麼 | 來源 |
|---|---|---|---|---|
| VS Code Remote-SSH | SSH | 開 SSH server，放公鑰或用密碼 | — | [VS Code docs](https://code.visualstudio.com/docs/remote/ssh) |
| VS Code Remote Tunnels | 電腦和用戶端都往外連 Microsoft 的 dev tunnels 服務，再在通道裡跑 SSH | `code tunnel`，用 GitHub 或 Microsoft 帳號做 device login | 用同一個帳號登入 | [VS Code docs](https://code.visualstudio.com/docs/remote/tunnels) |
| Termius、Blink（iOS SSH） | SSH | 開 SSH server | 用密碼登入一次，app 自己把公鑰裝到 `authorized_keys`（Termius「Export to host」、Blink `ssh-copy-id`） | [Blink docs](https://docs.blink.sh/basics/ssh-keys) |
| Rex（Superlogical） | Tailscale：`rex server start --tailscale` 讓 Rex 自己用 tsnet 加入 tailnet，成為一台獨立裝置（預設名稱 `rex`，可改），網址是 `https://<名稱>.<tailnet>.ts.net`；也可以改用電腦本身的 Tailscale Serve | 裝 Rex，第一次打開 `rex server status` 顯示的登入連結，或給 auth key | 輸入那個網址 | [Rex Remote Access](https://www.superlogical.com/rex/docs/linux/remote-access) |
| Happy（Claude Code 手機版） | 電腦和手機都往外連 Happy 的 relay，訊息端對端加密 | `npm i -g happy`，`happy claude` 顯示 QR code | 掃 QR code | [Happy](https://happy.engineering/quick-start/) |
| Claude Code Remote Control | Anthropic 的服務 | 在 Claude Code 裡打 `/remote-control` | 用同一個帳號打開，或掃 QR code | [Claude Code docs](https://code.claude.com/docs/en/remote-control) |
| Codex（ChatGPT app） | OpenAI 的服務 | 桌面 app › Settings › Connections › Control this Mac or PC，顯示 QR code | 掃 QR code，用同一個帳號核准 | [ChatGPT docs](https://learn.chatgpt.com/docs/remote-connections) |

最省事的那幾個（Happy、Claude、Codex、VS Code Tunnels）都靠自家的雲端服務來轉送。pi mobile 沒有自己的伺服器，資料也只留在手機上，所以這條路不適合。剩下兩條：一是 SSH，二是讓 tailnet 本身的身分當作登入。

## Tailscale 能給的

- **Tailscale SSH**（`tailscale set --ssh`）：由 Tailscale 驗證連線的裝置和使用者，SSH 這一層不需要金鑰也不需要密碼（協定上顯示成 `none`）。
  - 預設 policy 允許成員連到自己的裝置，但用 `check` 模式：每 12 小時要在瀏覽器重新登入一次。Personal 方案不能改這個時間。在背景跑排程的 agent 不適合用它。
  - Mac 上一般的 Tailscale app（官網版、App Store 版）**不能**當 Tailscale SSH server，只有命令列版的 `tailscaled` 可以。
  - [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)、[macOS variants](https://tailscale.com/docs/concepts/macos-variants)
- **Tailscale Serve**（`tailscale serve <port>`）：把電腦上只聽 localhost 的服務，用 `https://<電腦>.<tailnet>.ts.net` 分享給 tailnet，憑證自動申請。
  - 轉送時會加上 `Tailscale-User-Login` 等標頭，說明是哪個 tailnet 使用者發出的請求，並且先移除用戶端自己帶來的同名標頭，所以無法偽造。
  - Mac 上的兩種 app 都支援。
  - tagged 裝置發出的請求沒有這些標頭；被分享到這台裝置的外部使用者則有。所以服務要自己比對：來的人必須是電腦的主人。
  - [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- **tsnet**：程式自己內嵌 Tailscale，成為一台獨立裝置，用 `ListenTLS` 提供 HTTPS，用 `WhoIs(remoteAddr)` 查出連進來的是哪台裝置、屬於誰。
  - 第一次執行要打開登入連結，或提供 auth key；tailnet 有開裝置核准的話，還要在 Machines 頁核准。
  - Rex 用的就是這個。
  - [tsnet](https://tailscale.com/docs/features/tsnet)、[identity](https://tailscale.com/docs/concepts/tailscale-identity)
- 其他 Android app **拿不到** Tailscale app 看得到的裝置清單，因為沒有公開的 intent 或 API。要列出 tailnet 裡的裝置，只能用 Tailscale 的雲端 API 加上一把 key。所以手機只能讓使用者輸入電腦名稱（MagicDNS）或 IP。
  - [tailscale-android manifest](https://github.com/tailscale/tailscale-android/blob/main/android/src/main/AndroidManifest.xml)
- macOS 的「遠端登入」：系統設定 › 一般 › 共享 › 遠端登入，一個開關。
  - 用指令開（`sudo systemsetup -setremotelogin on`），要先給終端機「完整磁碟取用權限」。
  - 開了之後預設就能用帳號密碼登入。
  - [Apple](https://support.apple.com/en-ie/guide/mac-help/mchlp1066/27/mac/27)

## pi mobile 能走的三條路

### A. SSH，密碼登入一次（Termius 的做法）

- **電腦上**：Mac 打開「遠端登入」。Linux 要有 sshd，大多數桌面版預設就有。
- **手機上**：輸入電腦名稱、帳號、密碼。app 用密碼登入一次，把自己的公鑰加進 `authorized_keys`、上傳 pi-env，之後只用金鑰。密碼不保存。
- **主機金鑰**：第一次連線時直接信任。連線走 tailnet，Tailscale 已經用 WireGuard 確認過對方是哪台裝置，所以不必請使用者手動比對指紋。
- **好處**：電腦上不用裝任何東西，Mac 只要開一個開關；手機一個畫面就完成。pi-env 每次連線都會檢查版本，不一致就自動上傳，不再需要「安裝並連線」或「重新安裝」按鈕。
- **壞處**：
  - 有些 Linux 主機關掉了密碼登入（例如雲端 image），這時要退回「把公鑰貼到電腦上」的做法。
  - 手機上存的是一把能登入整台電腦的 SSH 私鑰。
  - 「遠端登入」不只聽 tailnet，也聽區域網路和公共 Wi‑Fi；只靠金鑰登入時風險不高，但開了密碼登入就會一起暴露。
- **要改的程式**：
  - `SshPlugin` 加上密碼和 keyboard-interactive 登入（macOS 的 sshd 通常走 keyboard-interactive）。
  - 新增電腦的畫面合併成一頁。
  - 連線時自動部署 pi-env。

### B. 電腦上跑一個服務，用 tailnet 身分驗證（Rex 的做法）

- **電腦上**：執行一行安裝指令，裝一個常駐的 pi host（可以由 pi-env 加一個 server 模式），交給 launchd 或 systemd 管理。
  - 它只聽 localhost，再透過 `tailscale serve` 分享出去；或者用 tsnet 自己成為 `<電腦>-pi` 這台裝置。
  - 每個請求都比對 `Tailscale-User-Login` 或 `WhoIs`，只接受跟電腦主人同一個 tailnet 使用者的手機。
- **手機上**：輸入 `https://<電腦>.<tailnet>.ts.net`，或只輸入電腦名稱。
- **好處**：
  - 手機上沒有任何金鑰或密碼；只要 Tailscale 登入著就能連，換手機也不用重設。
  - 不需要打開「遠端登入」，不聽區域網路。
  - 服務常駐，排程隨時都能用。
- **壞處**：
  - 電腦上要安裝東西並保持更新，第一次要在電腦前操作。
  - tsnet 要多登入一次並核准裝置；`tailscale serve` 要先在 tailnet 開啟 HTTPS 憑證，第一次會跳出同意提示。
  - 手機和電腦之間的通訊協定要換成 HTTPS 或 WebSocket，不能再走 SSH。

### C. Tailscale SSH

只適合 Linux：Mac 的一般 Tailscale app 不支援當 server，`check` 模式每 12 小時要重新登入。可以在手機連線時順便偵測，有的話就用，但不能當主要流程。

## 決定

選 B（2026-10-23），因為 A 一定要打開 port 22，而它會聽區域網路和公共 Wi‑Fi。做法見 [design/computer-host.md](../design/computer-host.md)：電腦上的 pi-mobile 只聽 Tailscale 位址，用 `tailscale whois` 確認對方是同一個使用者。

## 原本的建議

先做 **A**。理由是它對最多人最省事：Mac 開一個開關、手機一個畫面，現在的部署方式（手機透過 SSH 上傳 pi-env）也不用改。

做 A 的同時，順便處理兩件事：
- 「安裝並連線」和「重新安裝」按鈕拿掉，改成連線時自動部署。
- 容器模式收到進階選項。

B 比較安全，也最貼近 Tailscale，但要在電腦上裝東西、換掉通訊協定，可以當作下一步。之後如果要讓排程在電腦上常駐執行，或要拿掉手機上的私鑰，就是 B 該上場的時候。

不管選哪一條，都還有一件事要做：私鑰改存到 Android Keystore，讓它無法被匯出，不要再以明文放在 `files/ssh`。
