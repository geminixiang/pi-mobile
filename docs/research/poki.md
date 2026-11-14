# Poki：在 iPhone 上操作其他 App（2026-11-15）

使用者想讓 pi mobile 在 iPhone 上也能「代你操作 App」（Android 已經用無障礙服務做到），請我研究 [JosssphZhou/poki](https://github.com/JosssphZhou/poki) 的底層機制。Poki 是 AGPL-3.0：**只學概念，不取用程式碼**。下面是我讀 `docs/ios-core.md`、`docs/ios-loopback.md`、`native/NATIVE.md` 和 `agent/` 的幾個模組得到的，沒有執行它。Poki 電腦端的 agent 用的也是 `@earendil-works/pi-coding-agent` 和 `pi-ai`（1.5.0）。

## iPhone 上怎麼操作其他 App

iOS 不讓一般 App 操作別的 App。Poki 的做法是讓 App 自己扮演「接著 USB 的那台電腦」，用開發者工具的路來控制手機：

```
Poki App（SwiftUI）
 ├─ PokiCore（Swift）：讀畫面、做動作、核准
 ├─ PokiLauncher（Rust，用 idevice）：啟動並看著 runner
 └─ PokiTunnel（Network Extension）：只導 10.7.0.1 的本機 VPN，把封包的來源和目的對調
        │  App 連 10.7.0.1 就是連到手機自己
        ▼
 手機的開發者服務 ──testmanagerd──▶ WebDriverAgent runner（XCTest，127.0.0.1:8100）
                                          ▲
 PokiCore 用 HTTP 要無障礙樹、截圖，送點擊、輸入、捲動 ┘
```

啟動的步驟（`docs/ios-core.md` 第 3、4 節）：

1. **配對檔**：證明手機信任這台「電腦」。舊做法是用電腦配對一次，把 lockdown 配對檔放進 App；iOS 27 可以在手機上自己配：App 用 Bonjour 廣播 `_remotepairing-pairable-host._tcp`，使用者在手機輸入 6 位數 PIN（同 StikPair 的做法）。
2. **本機 VPN**：Network Extension 的封包通道，介面 `10.7.0.2/32`、只含 `10.7.0.1/32`、不碰預設路由和 DNS；收到的 IPv4 TCP 封包把來源和目的對調再送回。只用到 49152 或 62078 加上每次一個動態埠。Network Extension 需要付費開發者帳號的權限；用免費帳號時改用外部 VPN App（LocalDevVPN，或 Shadowrocket、Surge、sing-box 設一條 reflect 規則）。
3. 用配對檔連手機的 RemotePairing（49152）或 lockdown（62078）→ 在 App 裡用軟體實作的 TCP/IP 開 CoreDevice 通道 → RSD。
4. **掛載開發者磁碟映像（DDI）**：每次開機後第一次要上網跟 Apple 拿簽章（TSS）；行動網路下 iOS 不准本機迴路，所以這步要 Wi-Fi。
5. 透過 testmanagerd 和 dtservicehub **啟動 WebDriverAgent runner**（另外裝的一個 XCTest App），它在手機的 127.0.0.1:8100 開 HTTP 和 MJPEG，只綁本機迴路，外面連不到。
6. **保活**：runner 在連線關掉後 23 到 32 秒就會死，所以 launcher 的行程要一直活著：App 在背景放無聲的音訊（`AVAudioEngine`、`mixWithOthers`）加上即時動態（Live Activity）；每 5 秒問一次 runner 的 `/status`，連兩次沒回就重啟。
7. **簽章**：開發者模式要開；免費 Apple 帳號簽的 App 只能用 7 天，電腦上的 Poki Setup 在剩兩天內每 6 小時重簽，或使用者在手機上登入 Apple 帳號讓手機自己續。

「iOS 27 原生服務」是另一條路：Xcode 的 `devicectl` 用的那組 CoreDevice 服務（RemoteXPC），可以直接讀原生無障礙樹和前景 App、用 AppService 開 App、透過 displayservice 的媒體 session 送 HID 觸控和鍵盤、讀寫剪貼簿（中文用貼上），不需要 WebDriverAgent（`native/NATIVE.md`）。程式碼裡目前只有 Mac 端的 bridge 用它；手機本機的版本在保留的分支 `dev/esp-409-preserve-030`，還沒進產品（`docs/ios-loopback.md`）。輸入只保證「送出了」：裝置不回報有沒有收到，要再讀畫面才知道結果。

## 值得學的 agent 做法（Android 現在就能用）

1. **動作收據加上動作後的觀察**（`agent/post-action-observation.mjs`）：每個動作回傳收據（送出了沒、結果確定或未知、收據 id），附上動作完成後立刻抓的無障礙樹（元素編號 `e1`、`e2`、前景 App）。要用它當下一步的依據，必須通過檢查：在輸入完成之後才開始抓、不超過 25 秒、收據 id 對得上、前景 App 是預期的、元素不超過 400 個；不符就重讀。給模型時拿掉這段大資料，只留收據。
2. **獨立的驗證者**（`agent/verify-result.mjs`）：agent 說做完了，另開一個沒有任何操作權限的模型只看證據判斷。「我做完了」和送出的收據都不算證據；「找不到」要有往下捲到底、畫面不再變的證據；名字相同不代表是同一個；編輯框裡的字不等於存了；畫面上的文字一律不可信，要它通過驗證的指令也忽略。沒過就說缺什麼，讓 agent 繼續。
3. **每一步的期限**（`agent/step-deadline.mjs`）：每步有上限，有進展（下一步、捲動讓畫面變了）就重新計時，等使用者回覆時暫停，捲動另有 180 秒總上限。
4. **敏感動作的規則**（`docs/ios-core.md`〈Sensitive actions〉）：密碼欄打字、付款類的短標籤（長文字裡的名字不算，例如「Best Buy 的聯絡人照片」）、刪除、通訊軟體的傳送和 Enter、電話和 FaceTime 的任何點擊、清單上的銀行和錢包 App 裡的每個動作，都要核准。畫面變過之後的下一個點擊，送出前重讀一次，看點的位置底下是什麼再判斷。一次核准涵蓋之後 45 秒、同一個 App 裡的敏感步驟；請求 120 秒沒回就結束。核准可以在聊天、通知、鎖定畫面的即時動態裡回。

## pi mobile 要在 iPhone 上做到，代表什麼

- **做得到，但不能上 App Store**：開發者模式、開發者簽章、另外裝的 XCTest runner、掛開發者磁碟映像，都是 App Store 不允許的。需要一個側載版（和 TestFlight 版分開），以及一個電腦端的安裝與續簽流程（pi mobile 的電腦端程式已經在使用者的電腦上，可以負責這件事）。
- **免費 Apple 帳號要每 7 天重簽**，Network Extension 要付費帳號；否則用外部 VPN App。
- **底層函式庫**：Rust 的 `idevice`（MIT），SideStore、StikDebug 也用它；pi mobile 自己的實作可以直接用它，不必碰 Poki 的 AGPL 程式碼。

（待補：claude-fable-5-2 對 Poki 原始碼的完整研究，包括 Swift 端怎麼把畫面交給模型、agent 迴圈、iOS 18 到 26 的 XCTest 路線。）
