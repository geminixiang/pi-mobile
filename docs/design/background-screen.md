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
 ├─ app/src/oss/     Edition.kt 列出 AgentScreenPlugin；AgentScreenPlugin.kt（薄的轉接）
 └─ agentscreen/     獨立的 Gradle 模組，只有 oss 依賴（ossImplementation）
      AgentScreen.kt   對外入口：pair、open、key、watch、unwatch、takeover、close
      Discovery.kt     用 NsdManager 找自己的無線偵錯（_adb-tls-pairing、_adb-tls-connect），只認本機位址
      DisplayServer.kt 以 shell 身分執行（CLASSPATH=pi 的 APK app_process），開虛擬螢幕撐著，stdin 關掉就釋放
src/plugins/agent-screen.ts       合約；store 版沒有這個原生 plugin
src/phone-screen/background.ts    唯一決定在哪個螢幕做的地方（screenFor）
```

- **adb 用戶端用 [Kadb](https://github.com/Flyfish233/Kadb)**（`com.flyfishxu:kadb:2.1.5`，Apache-2.0）：配對（SPAKE2，`spake2-java` 在 JitPack，root `build.gradle` 只對 `com.github.Flyfish233` 開 JitPack）、TLS 連線、shell v2。不抄 mika 的 `core/adb`：程式碼更少，也不用帶授權註解。
- **兩個版本**：`store`（上架）沒有這個模組，`oss`（開源）有。共用程式碼用 `Edition.plugins.forEach(::registerPlugin)` 註冊 plugin，螢幕操作透過下述 `DisplayShell` 窄介面接上。`test/code-rules.ts` 擋其他地方碰 `AgentScreen`；`test/plugins-node.ts` 檢查 `oss` 的 plugin 有列在 `Edition.kt`。
- **使用者要做的**：開發人員選項 →「無線偵錯」→「使用配對碼配對裝置」，把六位數輸入 pi（`AgentScreen.pair`）。之後 pi 自己找埠、自己連。

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

1. **配對的畫面**：設定裡一個項目，帶使用者到無線偵錯、輸入配對碼；連不上時說原因（`debugging_off`、`not_paired`、`pairing_closed`、`wrong_code`）。現在只有 S24 由我配對過。
2. **看得到、能接手**：已在 API 36 模擬器實作「背景螢幕預覽」：H.264 原生浮窗、目前動作、拖到角落、隱藏、同一個 task 搬到 display 0。實作、重跑方式、量測與未驗證的限制見 [background-preview-report.md](background-preview-report.md)。S24 / API 37 尚未量。
3. **背景螢幕何時關**：現在開了就留到 pi 結束；之後在 Bot 都閒下來一段時間後關。
4. **無線偵錯會關**：換 Wi-Fi、重開機後系統會關掉無線偵錯。
5. 長時間背景螢幕的耗電；工具成本照 `docs/tools.md` 量。

## iPhone 第二階段：手機自己叫起 WebDriverAgent（2026-11-15，PoC）

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
