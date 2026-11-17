# 背景螢幕：Bot 操作 App 時不占用使用者的畫面（2026-11-15）

## 核心目的

「代你操作 App」（`phone_read_as_user`、`phone_act_as_user`）現在直接操作使用者眼前的畫面：Bot 一動，使用者就不能用手機。目的：Bot 在一個看不到的背景螢幕上開 App、讀、點，使用者照常用手機，想看再看。量測方式：Bot 操作期間，使用者在主螢幕打字、捲動不被打斷（主螢幕焦點不變），Bot 一步的讀取時間不比現在慢。

參考：[mika](https://github.com/wangzan101/mika)（Apache-2.0）在 Android 上就是這樣做的；iPhone 的對應做法見 [research/poki.md](../research/poki.md)。

## 已經驗證的（模擬器，Android 16 / API 36，2026-11-15）

用一支最小的程式（scratchpad 的 `VdProbe.java`，照 mika 和 scrcpy 的做法）以 adb 的 shell 身分執行：

| 項目 | 結果 |
|---|---|
| shell 身分用 `DisplayManager.createVirtualDisplay` 開虛擬螢幕，旗標 `PUBLIC`、`OWN_CONTENT_ONLY`、`SUPPORTS_TOUCH`、`ROTATES_WITH_CONTENT`、`DESTROY_CONTENT_ON_REMOVAL`、`TOUCH_FEEDBACK_DISABLED`、`TRUSTED`、`OWN_DISPLAY_GROUP`、`ALWAYS_UNLOCKED`、`OWN_FOCUS`、`STEAL_TOP_FOCUS_DISABLED` | 成功，display 2，`dumpsys display` 列出全部旗標 |
| 在背景螢幕開 App：`am start --display 2 -n com.android.settings/.Settings` | 成功 |
| 截背景螢幕：畫面畫進 `ImageReader`，存 PNG | 成功 |
| 在背景螢幕點擊：`input -d 2 tap 420 585` | 成功，進到下一頁 |
| 主螢幕的焦點不被搶 | `mTopFocusedDisplayId=0`；兩個螢幕各自有焦點視窗（主螢幕 pi、背景 Settings） |
| pi 自己的無障礙服務讀背景螢幕：`getWindowsOnAllDisplays()[2]` | 成功，53 ms 讀出 Settings 的元素（`PhoneScreen.read({ display: 2 })`，這個分支的改動） |

注意：第一次讀到空的，重新安裝讓無障礙服務在虛擬螢幕之後綁定，就讀得到；`dumpsys accessibility` 一直有追蹤 display 2。實作時要在建立螢幕後確認服務已經看到它再開始讀。

S24 實機（Android 17 / API 37、One UI 9，2026-11-15）同一支程式：背景螢幕帶全部旗標開成功（display 7）；`am start --display 7` 和 `input -d 7 tap` 都成功；主螢幕焦點不變（`mTopFocusedDisplayId=0`）。**真機才看到的問題**：使用者本來就開著「設定」（停在無線偵錯頁），`am start` 把那個工作整個搬到背景螢幕，而不是另開一份；釋放螢幕時它跟著被關掉。實作要避免搶走使用者正在用的 App：一律開成新的工作（`FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_MULTIPLE_TASK`，對不允許多開的 App 先確認它不在主螢幕上），mika 有專門處理的模組（`AppSwitch.kt`、`MainScreenSpill.kt`）可參考。

還沒驗證：用無障礙手勢對背景螢幕點擊（`GestureDescription.Builder.setDisplayId`，API 30；mika 在產品裡這樣用）、S24 實機（One UI 的多螢幕行為可能不同）、長時間背景螢幕的耗電。

## 架構（2026-11-15 定案：B，自帶 adb 用戶端）

```
android/
 ├─ app/src/main/    共用，不知道 adb 和背景螢幕
 ├─ app/src/store/   Edition.kt：沒有額外的 plugin（上架版）
 ├─ app/src/oss/     Edition.kt 列出 AgentScreenPlugin；AgentScreenPlugin.kt（薄的轉接）；AutoPairing.kt（設定流程中找配對視窗、讀配對碼、配對）
 └─ agentscreen/     獨立的 Gradle 模組，只有 oss 依賴（ossImplementation）
      AgentScreen.kt   對外入口：status、pair、watchPairing、open、key、watch、unwatch、takeover、close
      Discovery.kt     用 NsdManager 找自己的無線偵錯（_adb-tls-pairing、_adb-tls-connect），只認本機位址；找一次（ownPort）或一直看（discoverOwn）
      DisplayServer.kt 以 shell 身分執行（CLASSPATH=pi 的 APK app_process），開虛擬螢幕撐著，stdin 關掉就釋放
src/plugins/agent-screen.ts       合約；store 版沒有這個原生 plugin
src/phone-screen/background.ts    唯一決定在哪個螢幕做的地方（screenFor）
```

- **adb 用戶端用 [Kadb](https://github.com/Flyfish233/Kadb)**（`com.flyfishxu:kadb:2.1.5`，Apache-2.0）：配對（SPAKE2，`spake2-java` 在 JitPack，root `build.gradle` 只對 `com.github.Flyfish233` 開 JitPack）、TLS 連線、shell v2。不抄 mika 的 `core/adb`：程式碼更少，也不用帶授權註解。
- **兩個版本**：`store`（上架）沒有這個模組，`oss`（開源）有。共用程式碼用 `Edition.plugins.forEach(::registerPlugin)` 註冊 plugin，螢幕操作透過下述 `DisplayShell` 窄介面接上。`test/code-rules.ts` 擋其他地方碰 `AgentScreen`；`test/plugins-node.ts` 檢查 `oss` 的 plugin 有列在 `Edition.kt`。
- **使用者要做的**：開發人員選項 →「無線偵錯」→「使用配對碼配對裝置」，pi 看到自己的配對服務出現，用無障礙服務讀配對視窗裡的六位數、自己配對（`AutoPairing`）。之後 pi 自己找埠、自己連。

## 設定 › 手機 › 背景操作（2026-11-16）

開源版（`AgentScreen.pair` 有實作）的「代你操作 App」多一列「背景操作」（`BackgroundSetup`，`src/phone-screen/BackgroundSetup.tsx`），右邊是狀態，每次回到 pi 重查（`AgentScreen.status`）：

| 狀態 | `status` 的 reason | 怎麼判斷 | 下面顯示 |
|---|---|---|---|
| 可用 | （ok） | 背景螢幕已開著且連線還在，或用 TLS 連上自己的無線偵錯、跑得動 `true` | 無 |
| 未設定 | `developer_off` | `Settings.Global.DEVELOPMENT_SETTINGS_ENABLED` 是 0 | 說明連按七次版本號碼、到無線偵錯點配對碼；「打開關於手機」；配對碼輸入框 |
| 未設定 | `not_paired` | 連得到但認證被拒；或找不到無線偵錯而且從沒配對成功過 | 說明開啟無線偵錯、點配對碼；「打開無線偵錯」（開發人員選項，`toggle_adb_wireless` 那列反白）；配對碼輸入框 |
| 無線偵錯沒開 | `debugging_off` | 找不到 `_adb-tls-connect`，但配對成功過 | 說明開啟無線偵錯；「打開無線偵錯」 |
| 連不上 | 其他 | 原生的錯誤訊息照原樣列在下面 | 同「未設定」 |

「配對成功過」是 `filesDir/agent-screen-paired`：配對或連線成功時建立，認證被拒時刪掉。只用來分「未設定」和「無線偵錯沒開」，真正的配對在系統的無線偵錯裡。

### pi 自己讀配對碼

S24 上量過：配對視窗開著時切到 pi，視窗就關掉，輸入配對碼每次都是 `pairing_closed`；配對視窗留在前面時，用 pi 的無障礙服務讀它可行（讀約 10 ms、配對約 200 ms）。所以使用者不輸入，pi 在背景自己讀（`AutoPairing`，`android/app/src/oss/…/AutoPairing.kt`）：

1. 按「打開無線偵錯」（`AgentScreen.pairInSettings`）：開始看，再打開設定。呼叫一直等到看完才回覆。
2. **知道視窗開著，靠系統狀態**：看的期間 NSD 一直找 `_adb-tls-pairing._tcp`（`AgentScreen.watchPairing`），只收解析到本機位址的。這個服務只在配對視窗開著時由本機的 adbd 廣播，也給出配對埠。
3. **找配對碼，靠結構**：第一次看到服務起，每 200 ms 讀一次無障礙服務的 `windows`，只看根節點套件是 `ACTION_APPLICATION_DEVELOPMENT_SETTINGS` 解析出的套件的視窗。同一個視窗裡要剛好一個文字整段是六位數字（任何 Unicode 數字，`digitToInt` 轉成 ASCII），剛好一個文字是 `IP:埠`（`InetAddresses.isNumericAddress`），而且那個埠就是 NSD 廣播的配對埠。不比對標題或任何語言的字。都對上才 `pair(code, port)`；同一個埠只試一次。
4. **何時停**：配對成功或 `wrong_code`（成功時系統自己關掉配對視窗）、pi 回到前面（`handleOnResume`：使用者離開了流程）、或五分鐘到了。沒有 JS 計時器，也沒有新的 effect：回覆就是原本那個呼叫的結果，狀態由回到前景時既有的重查（`src/ui/resume.ts` 的 `resumed`）更新。
5. 回覆的 reason：`left`（回來時沒有可讀的配對視窗，不顯示）、`code_not_found`（看到服務、對不上結構）、`accessibility_off`、`timeout`、`wrong_code`、Kadb 的錯誤；寫在按鈕下面。

配對碼只在 `AutoPairing.look` 的區域變數裡（`PairingDialog`），傳給 `pair` 就丟掉：不記錄、不存、不顯示。

無障礙服務沒開時，說明的上面多一行「先開啟上面的無障礙服務，pi 才能自己配對」，用的是同一組「代你操作 App」裡原本的開關。

按鈕旁的小輸入框是手動的備案：打滿六位數就送出（`AgentScreen.pair`），錯誤（`pairing_closed`、`wrong_code`、`debugging_off`）寫在下面。只在配對視窗不會被關的時候有用（例如分割畫面）。

模擬器實測（2026-11-16，API 36，oss release build，`emulator-5554`）：

| | 結果 |
|---|---|
| 設定頁按「打開無線偵錯」→ 開無線偵錯 → 點配對碼 → 回到 pi | 「未設定」變「可用」，「已配對的裝置」多一筆 |
| `pairInSettings` 直接呼叫，設定是英文 ×3、阿拉伯文（`cmd locale set-app-locales com.android.settings --locales ar`，RTL）×3 | 6 次都 `{ok:true}`；adbd 的配對埠從開到關 0.89–1.09 秒（`/proc/net/tcp*` 每次約 10 ms 取樣，從點下算起：開 +0.12–0.24 s、關 +1.00–1.29 s） |
| 無障礙服務沒開時開配對視窗 | 視窗留著，回到 pi 得 `accessibility_off` |
| 沒開配對視窗就回到 pi | `left` |
| pi 的 logcat | 沒有配對碼 |

模擬器的 `ro.adb.secure=0`，刪掉 pi 的金鑰後 TLS 仍連得上，所以「未設定」只能靠關掉無線偵錯、刪掉 `agent-screen-paired` 做出來；配對有沒有發生看系統的「已配對的裝置」。

S24（One UI，繁中，2026-11-16，開源版 dev build）：`pairInSettings` 跑兩次都 `{ok:true}`；第二次從點「使用配對碼配對裝置」到系統關掉配對視窗不到 1.5 秒。One UI 會捲到「無線偵錯」那一項，但沒有明顯反白。配對視窗裡的位址是 Tailscale 的 IP，不影響判斷，因為只比對埠號。pi 的程序沒有記錄配對碼；Samsung 的 `system_server`（`AdbDebuggingManager: updateUIPairCode`）自己把配對碼印進 logcat，不在我們能管的範圍。

還沒在手機上驗：從「未設定」開始的整條 UI（S24 已經配對過；要回到未設定得撤銷 adb 授權，會連帶切斷測試用的連線）；開發人員選項沒開時從「關於手機」一路走到配對；其他廠牌。

## 實測（2026-11-15，oss 版 release build，R8 開著）

| | 模擬器（API 36） | S24（API 37、One UI 9） |
|---|---|---|
| `pair`（pi 用配對碼配對自己） | 成功 | 成功，0.6 秒 |
| `open`（NSD 找埠、TLS 連 127.0.0.1、從 APK 啟動 shell 端、開螢幕） | 0.3–0.4 秒，display 3、4 | 0.7 秒，display 8 |
| `launch` 設定 | 58 ms | 54 ms |
| 使用者主螢幕正開著「設定」時再 `launch` 設定 | 主螢幕的工作留著，背景另開一份 | 同左（之前 `am start` 不帶旗標會搬走使用者的那份；現在帶 `NEW_TASK \| MULTIPLE_TASK`） |
| `shot`（ImageReader → JPEG） | 42–62 ms（第一張 810 ms） | 570 ms（第一張） |
| `PhoneScreen.read({ display })` | 53 ms | 148 ms |
| 主螢幕焦點 | 不變 | 不變（`mTopFocusedDisplayId=0`） |
| `close` | 螢幕和裡面的 App 一起消失 | 同左 |

（用 `input -d N tap` 點擊在模擬器也通過；點擊打算改走既有的無障礙動作，所以沒有留在合約裡。）

## Bot 怎麼用（2026-11-15）

```
phone_read_as_user / phone_act_as_user（screen: background 預設 | front）
   └─ screenFor（src/phone-screen/background.ts）
        有背景螢幕：AgentScreen.open() → display
        沒有：在使用者的畫面做，結果第一行說為什麼
   └─ PhoneScreen.read / act（{ display }）── 無障礙服務（原有的 ScreenActor）
        點、滑、捲：手勢 setDisplayId
        打字、送出：那個螢幕的輸入焦點
        開 App：ActivityOptions.setLaunchDisplayId，新的工作
        返回等系統鍵：DisplayShells.current（開源版用 input -d 送；上架版沒有，回報做不到）
```

主程式的窄介面是 `DisplayShell`（`ScreenActor.kt`），開源版的 `AgentScreenPlugin.load()` 用 `DisplayShells.install` 安裝實作；主程式不知道 adb。預覽需要這個介面轉交無障礙服務的生命週期、目前動作與停止原因。`ScreenActor` 和接手共用一個鎖，正在執行的動作結束才搬 task；下一步回傳 `taken_over`，不是丟例外。`PhoneScreenPlugin` 按目標 display 取 metrics，不再假設每個螢幕都是主螢幕尺寸。

S24 實測（GPT 6.1 Sol，暫時的 Bot）：「用 Chrome 查一下台北現在幾度」41 秒答對；pi 一直在主螢幕，Chrome 在背景螢幕。

## 還沒做

1. **配對的畫面**：見上面〈設定 › 手機 › 背景操作〉。
2. **看得到、能接手**：已在 API 36 模擬器實作「背景螢幕預覽」：H.264 原生浮窗、目前動作、拖到角落、隱藏、同一個 task 搬到 display 0。實作、重跑方式、量測與未驗證的限制見 [background-preview-report.md](background-preview-report.md)。S24 / API 37 尚未量。
3. **背景螢幕何時關**：現在開了就留到 pi 結束；之後在 Bot 都閒下來一段時間後關。
4. **無線偵錯會關**：換 Wi-Fi、重開機後系統會關掉無線偵錯。
5. 長時間背景螢幕的耗電；工具成本照 `docs/tools.md` 量。

## iPhone：in-process XCTest（2026-11-15）

核心目的：讓開源版的 `phone_read_as_user` / `phone_act_as_user` 直接操作前景 App，不用切掉使用者的 VPN，也不用另外安裝、啟動 WDA runner

程式的分工（讀 `ios/AgentScreen/`、`ios/OSS/project.yml`、`scripts/ios-oss.sh`）：

- `Edition.swift` 透過 `MainViewController` 的 `EditionPlugins` seam 註冊 `PhoneScreenPlugin`；App Store target 不編譯 `ios/AgentScreen/`
- `InProcess.m` 在 serial queue 上動態載入 developer frameworks，建立 daemon session，讀 accessibility snapshot、合成 touch / text event、開 App、取 PNG；private calls 都在 exception boundary 和 15 秒 deadline 內。逾時回 `session_timeout`，拒絕後續要求直到重開 pi；已交給 OS 的動作不能取消，不可盲目重試
- `PhoneScreenPlugin.swift` 負責現有 contract、依序做 steps、把 snapshot 轉成 Android 同樣的 role / label / center-point 格式；截圖縮成同一套 point coordinates 的 JPEG。前景選第一個不是 pi 的 active application，只有 pi 時讀 pi
- `ScreenAwake.swift` 負責 native `AVAudioEngine` 全零 source node 和 WebView 的 silent WAV。read / act 及每個 step 續租 180 秒；pi 回前景立即停兩邊。180 秒是有限的 idle grace，容許模型思考及兩分鐘背景驗證，不是永久背景服務。不能保證鎖屏或系統強制終止後繼續
- `key back` 優先按 `取消` / `Cancel` / `關閉` / `Close`，否則左緣返回手勢；`home` 用 XCTest 的 Home button，`notifications`、`quick_settings` 是頂緣手勢，`enter` 是換行。iOS 沒有 Android 的通用 Back API，App 沒做返回手勢時可能不動，結果會帶 `unchanged`
- `recents` 目前回 `unsupported_key`，iPhone capabilities 必須排除它。實機上底緣手勢只捲動 Settings，連續 Home presses 只回主畫面，不能把 branch coverage 當成已實作成功。沒有改共用 `KEYS`，Android 仍支援它

先從 Mac 掛載 developer disk image，再執行：

```sh
DEVICE=<udid> sh scripts/ios-oss.sh build
```

DDI 在重開機後可能不在。plugin 的 `status` / `read` / `act` 會 reject，原因以 `ddi_missing` 開頭，說明要從電腦掛載再重開 pi；不是 Android accessibility 權限被關掉，也不會自己開 VPN 或彈授權

`Wda.swift`、`AgentLink.swift` 已移除。`ios/agentscreen-rs`、`ios/LoopbackTunnel` 保留供以後掛載 DDI 用，但 app 不連結、不 embed、不啟動它們；`pair` 指令只留下配對檔，不參與 screen session

建置及實機驗證見 worktree 的 `.report.md`；未驗證的項目不能從上面的程式分工推論成已支援

實機重跑用 `test/device/ios-screen.js`，先啟動 `pymobiledevice3 webinspector cdp --udid <udid> --port 9240`。它透過真正的 Capacitor plugin 呼叫，另一次同步 evaluate 取結果，不依賴 bridge 的 awaitPromise；result 會驗證現有 PhoneScreen schema 和指定欄位，存 JSON 與 JPEG。每次 act 前先看畫面，不自動點授權或設定開關

```sh
node --import ./test/vite-imports.js test/device/ios-screen.js start read '{"screenshot":true}'
node --import ./test/vite-imports.js test/device/ios-screen.js result /tmp/ios-read.json '{"package":"com.apple.Preferences"}'
node --import ./test/vite-imports.js test/device/ios-screen.js start act '{"steps":[{"action":"key","key":"back"}],"screenshot":true}'
node --import ./test/vite-imports.js test/device/ios-screen.js result /tmp/ios-back.json '{"done":1,"keyboard":false}'
```

## iPhone 舊方案：手機自己叫起 WebDriverAgent（2026-11-15，歷史 PoC）

以下是已被 in-process session 取代的實驗，不是目前 runtime 的需求

做法照 [research/poki.md](../research/poki.md)，函式庫用 Rust 的 [idevice](https://github.com/jkcoxson/idevice)（MIT）。PoC 是 scratchpad 裡獨立的測試 App（不動 `ios/App`）：一個 Rust 靜態庫、一個 Network Extension 封包通道、一份配對檔。iPhone 12 Pro、iOS 27.2。

| 步驟 | 結果 |
|---|---|
| Mac 上 `idevice-tools xctest` 經 USB 啟動 WDA runner（不經 Xcode） | 成功，WDA 回狀態、截圖 |
| Mac 上只拿 lockdown 配對檔、經 Wi-Fi 直連啟動 WDA | 成功 |
| 手機上：本機 VPN（介面 10.7.0.2、只導 10.7.0.1，封包來源和目的對調送回）＋ lockdown 配對檔連 10.7.0.1:62078 | **失敗**：TCP 交握成功，lockdownd 接受後立刻關掉（iOS 27 在這條路上擋 lockdown） |
| 手機上：同一個 VPN ＋ RemotePairing 配對檔連 10.7.0.1:49152 | 成功，47 ms 連上，RSD 列出 85 個服務（testmanagerd、dtservicehub、installation_proxy 都在） |
| 手機上：經 RSD 啟動 WDA runner | 成功：App 內 `127.0.0.1:8100` 回 WDA 狀態；runner 的 PID 緊接在 App 之後，App 一關它就消失（不是 Mac 啟動的那個）；跑兩次都成功 |
| 手機上不開 VPN、直接連自己的 Wi-Fi 位址 | 失敗，所以本機 VPN 是必要的 |

要讓它動，在 idevice 加了一個入口 `XCUITestService::run_over_rsd`（吃一條已經建好的 RSD 通道；原本的 `run` 一定先經 lockdown 拿 CoreDeviceProxy）。這是本地修改，還沒送回上游。

RemotePairing 配對檔是在 Mac 上經 USB 不用按任何東西產生的（`idevice-tools remotepairing_lockdown pair`）。iOS 27 也能在手機上自己配（App 廣播 `_remotepairing-pairable-host._tcp`，使用者在手機輸入 PIN，idevice 的 `pairable_host`），還沒試。

### 要決定或還沒做的

- **VPN 只能開一個**：本機 VPN 一開，使用者原本的 VPN（例如 Tailscale）就斷了。Poki 和 StikDebug 都有這個限制；要想辦法只在 Bot 操作時開、做完還原，或接受它。
- **開發者磁碟映像**：這次 iPhone 上已經掛著（之前跑過 Xcode）。重開機後要在手機上自己掛（personalized DDI，第一次要經網路跟 Apple 簽，idevice 有）。
- **保活**：App 關掉或被系統暫停，runner 約 30 秒內就死。要照 Poki 用背景音訊加即時動態，或只在 pi 在前景時用。
- **簽章和上架**：要付費開發者帳號才有 Network Extension；WDA runner 和開發者模式都不能上 App Store，只能放開源版或側載版。
- **接進 pi**：照之前講好的分開放（開源版 target、`ios/agentscreen-rs`、`ios/LoopbackTunnel`），讀和點走 WDA 的 HTTP。
