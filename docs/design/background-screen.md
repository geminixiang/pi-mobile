# 背景螢幕：Bot 操作 App 時不占用使用者的畫面（2026-11-15，草案）

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

還沒驗證：用無障礙手勢對背景螢幕點擊（`GestureDescription.Builder.setDisplayId`，API 30；mika 在產品裡這樣用）、S24 實機（One UI 的多螢幕行為可能不同）、長時間背景螢幕的耗電。

## 架構

```
pi（WebView）
  phone_act_as_user / phone_read_as_user（多一個「在背景」的模式）
        │ PhoneScreen plugin
        ▼
  ┌──────────────── pi App 行程 ────────────────┐
  │ PhoneScreenService（無障礙服務，原有）        │
  │   讀：getWindowsOnAllDisplays()[背景螢幕]     │
  │   點：dispatchGesture(setDisplayId(背景螢幕))  │
  └──────────────────────────────────────────────┘
        │ binder
  ┌──────── shell 身分的小服務（新） ────────┐
  │ 建立／釋放背景螢幕（createVirtualDisplay） │
  │ 在上面開 App（am start --display N）       │
  │ 截圖（ImageReader）                        │
  └──────────────────────────────────────────┘
        ▲ 怎麼拿到 shell 身分：見下方要決定的事
```

shell 身分只負責「螢幕」和「開 App」；讀和點盡量交給原有的無障礙服務，新寫的程式最少。

## 要使用者決定的事

**怎麼拿到 shell 身分**（兩條路都要使用者在手機上配對一次「無線偵錯」）：

| | A. Shizuku | B. 內建 adb 用戶端（mika 的做法） |
|---|---|---|
| 使用者要做的 | 另外安裝 Shizuku App，在裡面配對一次 | 在 pi 裡配對一次 |
| pi 要寫的 | 約一百行接線（Shizuku UserService） | 約 1,600 行：SPAKE2 配對、Ed25519、TLS、adb 協定（mika 的 `core/adb`，Apache-2.0 可參考） |
| 重開機後 | Shizuku 要重新啟動（無線偵錯需要 Wi-Fi） | 同樣要重新連自己的無線偵錯 |
| 風險 | 依賴第三方 App | 自己維護一套安全相關的協定實作 |

建議 A：符合「能用成熟的就不自己寫」，程式碼最少；之後真的需要再換 B。

## 步驟（每一步都能單獨上線）

1. `PhoneScreen.read` 可以指定螢幕（這個分支已做，模擬器驗證）。
2. shell 服務：建立、釋放背景螢幕，在上面開 App，截圖（依上面的決定）。
3. 點擊和輸入帶上螢幕（無障礙手勢的 `setDisplayId`；文字輸入走剪貼簿或 `input -d`）。
4. 工具：`phone_act_as_user` 預設在背景做；畫面上顯示一個小視窗（即時畫面，點一下放大、接手）。
5. S24 實機驗證：主螢幕打字不被打斷、讀取時間、耗電；照 `docs/tools.md` 量工具成本。
