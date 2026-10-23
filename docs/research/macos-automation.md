# macOS：權限、簽章與畫面操控

2026-10-23。`pi-mobile serve`（`host/main.go`）和 `pi-mobile mcp computer`（`host/computer_darwin.go`）在 macOS 上依賴的系統機制：誰被問權限、權限記在誰身上、更新後為什麼會掉，以及截圖、滑鼠鍵盤、前景 app 各用什麼 API。標「實測」的是在 Mac mini（M4，macOS 27）上量到的，其他都附 Apple 的一手出處。

## 權限（TCC）記在誰身上

**問的是「負責的程式」，不是實際執行的那個程序。**
- Apple 的 Quinn 解釋：TCC 會把 helper 的存取算在它的 *responsible code* 身上；負責關係和父子關係是兩回事。由 launchd 啟動、又沒有對應 app 的 agent，Apple 建議在 launchd plist 加 `AssociatedBundleIdentifiers`，讓系統知道它屬於哪個 app。（[On File System Permissions](https://developer.apple.com/forums/thread/678819)、[TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)）
- `man launchd.plist`：`AssociatedBundleIdentifiers` 決定這個 job 在「系統設定 › 登入項目」裡顯示成哪個 app；app 自己安裝的舊式 plist 應該填上 app 的 bundle id。
- **實測**：`pi-mobile serve` 由 launchd 啟動，它經 `/exec` 開的子程序（`pi-mobile mcp computer`、`screencapture`、`osascript`）用到的權限，都算在 `pi-mobile serve` 身上。從我的終端機直接執行同一個 binary，`AXIsProcessTrusted()` 是 false；從 serve 的 `/exec` 執行是 true。

**權限綁的是簽章的 designated requirement（DR）。**
- TN3127：macOS 用 DR 判斷「現在要存取的程式」是不是「使用者之前允許的那支」。ad-hoc 簽章也有 DR，但綁的是那一版的程式碼（cdhash），重新編譯後就對不上，於是重新詢問；沒簽章的程式則根本沒有 DR。要跨版本保留，得用固定的簽章身分，並且保持同一個 signing identifier。（[TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)）
- **實測（這次更新踩到的）**：CI 建的 binary 是 Go linker 的 ad-hoc 簽章，`codesign -dv` 顯示 `Identifier=a.out`、`Signature=adhoc`。更新後：
  - 檔案與 System Events 會重新跳出詢問。
  - 螢幕錄製和輔助使用**不會再問**：列表裡那個舊的 pi-mobile 開關還是開的，但對新版不算數，要用「−」刪掉、再「+」加回來。
- `man codesign`：`-i` 指定簽章裡的 identifier；沒給時取自 Info.plist，否則取檔名。Apple 說不同程式用同一個 identifier 是「very bad idea」。

**自簽憑證可以給出固定的 DR（實測）。**
- 用 openssl 產生一張 `extendedKeyUsage=codeSigning` 的自簽憑證，匯入鑰匙圈。`security find-identity` 會把它列為 `CSSMERR_TP_NOT_TRUSTED`，但 `codesign -s "pi-mobile (local)" -i dev.pi-mobile` 照樣能簽。
- 簽完的 DR 是 `identifier "dev.pi-mobile" and certificate leaf = H"71fd…"`，`codesign --verify --strict` 通過，也滿足這條 DR。
- **實測，可行**：用這張憑證把 `pi-mobile.app` 授權一輪（檔案、System Events、輔助使用、螢幕錄製），再裝一個不同版本、雜湊不同的 binary，用同一張憑證簽：六項都還是允許，沒有跳出任何詢問。TN3127 建議的是 Apple 發的身分；未被信任的自簽憑證，TCC 一樣接受。

## 怎麼要權限

| 權限 | 檢查（不詢問） | 要求（會詢問） | 出處 |
|---|---|---|---|
| 輔助使用 | `AXIsProcessTrusted()` | `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true})`；詢問是非同步的，這次呼叫的回傳值不會因此改變，之後要再檢查 | [Apple](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions) |
| 螢幕錄製 | `CGPreflightScreenCaptureAccess()` | `CGRequestScreenCaptureAccess()`，可能跳出詢問 | [Preflight](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess())、[Request](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess()) |
| 檔案與檔案夾、自動化 | 無公開 API | 實際去讀資料夾、送 Apple Event 時才會問 | （`host/main.go` 的 `permissions` 就是這樣做的） |

- **為什麼這次輔助使用不在列表裡**：程式從沒呼叫過要求的 API，只用 `AXIsProcessTrusted()` 檢查，所以系統不會把它加進列表，也不會詢問。改用 `AXIsProcessTrustedWithOptions` 加上 prompt 就會。
- **名稱和 logo（實測）**：包成 `pi-mobile.app`（Info.plist、`.icns`），launchd plist 填 `AssociatedBundleIdentifiers` 後：
  - 系統設定的列表顯示 pi-mobile 的 logo。
  - 詢問視窗寫的是「pi-mobile」，並帶上 Info.plist 的用途說明（例：「讓手機上的 pi 讀寫桌面上的檔案。」）。但詢問視窗的圖示是系統的（資料夾、鎖頭），不是 app 的 logo。
- **主動要的效果（實測）**：
  - 輔助使用：`AXIsProcessTrustedWithOptions` 加上 prompt 之後，系統跳出詢問，並把 pi-mobile 加進列表。
  - 螢幕錄製：`CGRequestScreenCaptureAccess` 也一樣，但它的詢問會排在其他系統詢問後面，前一個關掉才出現。打開開關後要重新啟動程式才生效，接著 macOS 會再問一次「略過系統私密視窗選擇器」。
  - 打開輔助使用的開關需要使用者的登入密碼。

## 螢幕錄製的「每月再問一次」

- macOS Sequoia 起，直接截取螢幕（不經系統的選擇視窗）的程式，會定期看到「正在要求略過系統私密視窗選擇器」的提醒。
- Apple 給的出路只有三條，對 pi-mobile 都不適用：
  - 互動式的分享用 `SCContentSharingPicker`，由使用者每次自己選要分享的畫面。（[WWDC23 10053](https://developer.apple.com/videos/play/wwdc2023/10053/)）
  - 無人值守的 VNC 類 app，可以向 Apple 申請受限的 `com.apple.developer.persistent-content-capture` entitlement，要 Apple 核准。（[entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)）
  - 受管理的 Mac 可以用 MDM 的 `forceBypassScreenCaptureAlert`（macOS 15.1 起），只關掉提醒，不等於授權。（[Restrictions](https://developer.apple.com/documentation/devicemanagement/restrictions)）
- 結論：一般使用者的 Mac 沒有官方方法永久關掉這個提醒。

## 截圖

- `CGWindowListCreateImage` 在 macOS 15 的 SDK 標為 obsoleted，Apple 要 app 改用 ScreenCaptureKit 的 `SCScreenshotManager`（非同步）。obsoleted 是編譯期不能用，不代表舊的 binary 執行時一定失效。（[macOS 15 release notes](https://developer.apple.com/documentation/macOS-Release-Notes/macos-15-release-notes)、[SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)）
- 我們用 `screencapture`：`-x` 不出聲、`-m` 只截主螢幕、`-t jpg` 指定格式、`-C` 連游標一起截、`-R` 截一個矩形、`-l` 截一個視窗（`man screencapture`）。
- **實測**：`screencapture -x -t jpg` 截 1920×1080 約 75 毫秒，PNG 約 257 毫秒。computer-use-mcp 每張要 2–7 秒，是因為它先存 PNG 再讀回來重新編碼。
- ScreenCaptureKit 需要 Objective-C／Swift 的 async 呼叫和 run loop，用 purego 從 Go 呼叫不划算；`screencapture` 已經夠快，維持現狀。

## 滑鼠和鍵盤（Quartz events）

- `CGEventKeyboardSetUnicodeString` 的文件沒寫長度上限。Chromium 的遠端桌面發現一個事件最多只處理 20 個 UTF-16 單位，所以會分段送。（[Apple](https://developer.apple.com/documentation/coregraphics/cgevent/keyboardsetunicodestring(stringlength:unicodestring:))、[Chromium input_injector_mac.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/remoting/host/input_injector_mac.cc)）
- **實測**：計算機一個事件只讀第一個字，所以我們改成一個字一個事件；中文正常。
- **實測**：組合鍵只在按鍵上帶 modifier flags，Spotlight 的 cmd+space 沒有反應；要把 modifier 當成獨立的按鍵按下、放開，系統快捷鍵才會觸發。

## 前景 app 和視窗

- **實測**：從背景程序對 `AXUIElementCreateSystemWide()` 要 `AXFocusedApplication`，回 `-25204`（`kAXErrorCannotComplete`）。Apple 沒寫原因。改成先用 `lsappinfo` 拿前景 app 的 pid，再對 `AXUIElementCreateApplication(pid)` 要 `AXFocusedWindow` 的標題，就拿得到。
- `lsappinfo`（`man lsappinfo`）查的是 CoreApplicationServices 的 app 狀態：`front` 是前景 app，`list` 列出全部，`info -only pid` 取欄位；它也有 `kill` 指令，可以用 SIGTERM 結束 app。
- **實測**：
  - `lsappinfo front` 加 `info` 約 10 毫秒，`list` 約 35 毫秒。
  - `list` 會列出已經結束的 app（標成 `(terminated)`，沒有 `pid =` 欄位），解析時要跳過。Safari 就是這樣。
- `NSWorkspace` 的前景 app 是靠 run loop 收到的通知更新的；沒有 run loop 的 Go 程序拿到的可能是舊資料，所以不用它。（推論，未實測。）

## 對 pi-mobile 的結論

1. **包成 `pi-mobile.app`**：Info.plist、bundle id `dev.pi-mobile`、`.icns`、`LSUIElement`，launchd plist 加 `AssociatedBundleIdentifiers`。詢問和設定裡就會有名稱和 logo。
2. **用固定的簽章身分**：安裝時用一張自簽憑證，以 identifier `dev.pi-mobile` 簽。這要實際驗證一次「更新後權限還在」；不行的話，退路是用 Apple Developer ID（要付費帳號，也能做公證）。
3. **主動要權限**：輔助使用用 `AXIsProcessTrustedWithOptions` 加 prompt；螢幕錄製用 `CGRequestScreenCaptureAccess`。這樣兩者都會出現在列表裡，不用手動按 +。
4. **每月的螢幕錄製提醒避免不了**：在文件和安裝說明裡講清楚就好。
5. **維持 `screencapture`、Quartz events、`lsappinfo`**：都量過夠快；ScreenCaptureKit 和 NSWorkspace 對沒有 run loop 的 Go 程序不划算。
