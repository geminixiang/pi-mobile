# 這支手機能用哪些工具

狀態：2026-10-24 提出。第一層（這個 app 有沒有那個原生 plugin）2026-10-25 做好了；硬體這一層還沒做。

## 第一層：plugin（已做）

App 啟動時讀 Capacitor 的 `PluginHeaders`，知道每個原生 plugin 實作了哪些方法（`src/plugins/define.ts`），結果是 `Platform.native`：`has(plugin)` 看 plugin 在不在，`implements(method)` 看方法有沒有實作。每個工具在 `defineAppTool` 寫它要的方法（`needs`），少了方法的工具不安裝，工具全都裝不了的工具組面板也不列；設定頁的分頁、首頁的建議、附加選單看 `has`。介面規範見 [tools.md](../tools.md)〈原生 plugin〉。

- Android：20 個都有，跟以前一樣。
- 瀏覽器：一個都沒有，等於以前的「只在手機上」清單。
- iOS：實作一個 plugin 的部分方法，只用到那些方法的工具就出現，不用改其他地方（`test/plugins-node.ts` 記下 iOS 實作了哪些方法）。

所以 `requireNative()` 拿掉了：工具只在方法有實作時才裝，呼叫時不用再檢查。新的原生 plugin 在 `src/plugins/` 用 `definePlugin` 寫 contract，加進 `src/plugins/index.ts` 的 `PLUGINS`。

## 問題

工具組的 `available`（`src/agent/toolsets.ts`）現在只看「設定好了沒」，例如 GitHub 沒有 token 就顯示「尚未設定」，不看這支手機能不能用。沒有氣壓計、沒有 NFC、沒有 Health Connect 的手機，模型照樣看得到這些工具，用了才失敗。

## 三種「用不了」

| 種類 | 例子 | 會變嗎 | 處理 |
|---|---|---|---|
| 硬體沒有 | 氣壓計、NFC、Health Connect、Samsung 私有的感測器 | 不會 | 測一次記下來；模型看不到這個工具或欄位 |
| 權限沒給 | 通知讀取、位置「一律允許」、精確鬧鐘、鄰近裝置 | 隨時會變 | 不藏：模型看得到，用的時候引導使用者去開 |
| 服務沒設定 | GitHub、雲端、電腦 | 會 | 現有的「尚未設定」 |

## 做法

- **什麼時候測**：第一次啟動、app 更新後、Android 版本變了之後。結果存在原生端，帶著 app 版本和 Android 版本，任一個不同就重測。
- **怎麼測**：能問系統的就問，不實際呼叫工具，所以很快也沒有副作用：`PackageManager.hasSystemFeature`、`SensorManager.getSensorList`、Health Connect 的 `getSdkStatus`。只有問不到的才實際呼叫一次。
- **粒度到工具和欄位**：`read_sensors` 在沒有氣壓計的手機上只少掉氣壓和海拔，說明也跟著少那一句，不是整個工具不能用。
- **觸發也用它**：這支手機沒有的感測器、沒有 NFC，`create_schedule` 就不提供那種 When。
- **面板**：硬體沒有的工具組顯示「這支手機沒有」，不能打開。

## 先量

在 S24 和模擬器上各跑一次 `getSensorList` 和 `hasSystemFeature`，看兩台差多少，再決定清單要多細。Samsung 私有的感測器（`Drop Classifier`、`Car Crash Detect`、`Pocket mode`）要確認第三方 app 能不能註冊，`dumpsys sensorservice` 列得出來不代表 pi 拿得到。
