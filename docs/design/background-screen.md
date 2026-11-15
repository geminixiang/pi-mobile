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
      AgentScreen.kt   對外唯一的類別：pair、open、launch、shot、close
      Discovery.kt     用 NsdManager 找自己的無線偵錯（_adb-tls-pairing、_adb-tls-connect），只認本機位址
      DisplayServer.kt 以 shell 身分執行（CLASSPATH=pi 的 APK app_process），開虛擬螢幕，stdin 收 shot、關掉就釋放
src/plugins/agent-screen.ts  合約；store 版沒有這個原生 plugin，native.has 回 false
```

- **adb 用戶端用 [Kadb](https://github.com/Flyfish233/Kadb)**（`com.flyfishxu:kadb:2.1.5`，Apache-2.0）：配對（SPAKE2，`spake2-java` 在 JitPack，root `build.gradle` 只對 `com.github.Flyfish233` 開 JitPack）、TLS 連線、shell v2。不抄 mika 的 `core/adb`：程式碼更少，也不用帶授權註解。
- **兩個版本**：`store`（上架）沒有這個模組，`oss`（開源）有。共用程式碼只多一行 `Edition.plugins.forEach(::registerPlugin)`。`test/code-rules.ts` 擋其他地方碰 `AgentScreen`；`test/plugins-node.ts` 檢查 `oss` 的 plugin 有列在 `Edition.kt`。
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

## 還沒做

1. **讓 Bot 用**：`phone_read_as_user`、`phone_act_as_user` 在背景螢幕上做（讀已經能指定螢幕；點擊用無障礙手勢的 `setDisplayId`、開 App 走 `AgentScreen.launch`）。動工前先畫圖確認。
2. **配對的畫面**：設定裡一個項目，帶使用者到無線偵錯、輸入配對碼；連不上時說原因（`debugging_off`、`not_paired`、`pairing_closed`、`wrong_code`）。
3. **無線偵錯會關**：換 Wi-Fi、重開機後系統會關掉無線偵錯，要使用者再開；是否能在連著時保持開啟要再測。
4. 長時間背景螢幕的耗電；工具成本照 `docs/tools.md` 量。
