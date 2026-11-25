# Android 系統級新能力與 pi mobile

調查日期：2026-10-19。問題：Android 官方正在推的系統能力裡，有沒有能用在「手機上的 agent」的技術，特別是取代或補充樹莓派 sandbox。

結論先講：

- **Linux Terminal（AVF 虛擬機）** 跟我們的 sandbox 最接近，但這支 S24 不支援，第三方 app 也不能自己開 VM。
- **AppFunctions** 是 Android 版的「MCP 工具」，方向對，但目前只有系統認可的 agent 能呼叫別的 app。
- **Gemini Nano Prompt API** 是手機上的本地模型，但 S24 不在支援清單，而且上下文太短，不適合當 agent 主模型。
- 實際可以馬上用的，只有 Android 17 的一些行為改變（要注意）和前景服務（讓長任務在背景活著）。

## 1. Linux Terminal / Android Virtualization Framework (AVF)

**是什麼**：系統內建的 Terminal app 用 AVF 開一個 Debian 虛擬機，不是進 Android 本身的 shell。Android 16 的版本說明稱之為 Ferrochrome。在開發人員選項打開「Linux 開發環境」後，第一次啟動會下載 Linux image。([source.android.com：AVF 使用情境](https://source.android.com/docs/core/virtualization/usecases)、[Android 16 版本說明](https://source.android.com/docs/whatsnew/android-16-release))

**跟 pi mobile 的關係**：VM 裡就是完整的 Debian（`apt`、`git`、`ssh`），等於把樹莓派搬進手機。Terminal 有「Port control」設定，VM 裡聽 1024 以上 port 的服務，經使用者允許後會轉到 Android 的 `127.0.0.1`，同一支手機上的其他 app 連得到。([AOSP TerminalApp strings.xml](https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/android/TerminalApp/res/values/strings.xml))

所以理論上的做法：在 Terminal 的 Debian 裡跑我們的 relay（不用 Docker，或在 VM 裡跑 Docker），pi mobile 連 `ws://127.0.0.1:8787`。這樣有真正的 VM 隔離，比 Termux 強。

**限制**：

1. **裝置支援看機型和晶片，不看 Android 版本**。Google 的入門文件只列特定 Pixel 和 Cuttlefish。([AVF getting started](https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/docs/getting_started.md)) 三星方面，Android Authority 實測 Exynos 的 Z Flip7、S26 可以用，Snapdragon 的 Z Fold7 和 S25 系列不行；One UI 8.5 在支援的機型上加了圖形 Linux app。([Android Authority：Z Flip 7](https://www.androidauthority.com/galaxy-z-flip-7-linux-terminal-3578675/)、[One UI 8.5](https://www.androidauthority.com/samsung-phones-linux-terminal-one-ui-8-5-3652503/))
2. **這支 S24 實測不支援**（adb 檢查，Android 16、One UI 8.5、SM8650）：
   - `com.android.virtualization.terminal` 有裝，但 `enabled=0`（停用）。
   - 沒有 `/dev/kvm`，也沒有任何 `hypervisor` 系統屬性。
3. **第三方 app 不能自己開 VM**。`MANAGE_VIRTUAL_MACHINE` 的保護等級是 `signature|preinstalled|development`，一般安裝的 app 拿不到；`VirtualMachineManager` 是 `@SystemApi`。只能透過系統的 Terminal app，間接用它的 port 轉發。([AVF 權限宣告](https://android.googlesource.com/platform/packages/modules/Virtualization/+/refs/heads/main/android/android.system.virtualmachine.res/AndroidManifest.xml)、[AVF API README](https://android.googlesource.com/platform/packages/modules/Virtualization/+/refs/tags/aml_net_351410000/libs/framework-virtualization/README.md))
4. Google 10 月 12 日發表了 Googlebook 上的 Linux Terminal 預覽，強調 AI 和開發用途；GPU/NPU 加速、整合 GUI app 列為未來計畫，不是現在的功能。([Android Developers Blog](https://developer.android.com/blog/posts/googlebook-linux-terminal-preview-vm))

**結論**：方向最符合，但要等換支援的手機（例如 Exynos 版 S26）。在 S24 上，手機內的 sandbox 只能走 Termux。

## 2. AppFunctions（Android 版的 MCP）

**是什麼**：app 把特定動作和資料宣告成工具，系統建立索引，經授權的 agent 可以查詢和呼叫。Google 把它定位成「裝置上的 MCP 工具」。Android 16 起可用，Android 17 擴充。Jetpack 最新是 `androidx.appfunctions:appfunctions:1.0.0-alpha13`（2026-10-07），還是實驗性預覽；alpha13 把 `@AppFunction` 改名為 `@AppFunctionDeclaration`。([AppFunctions 概覽](https://developer.android.com/ai/appfunctions)、[Jetpack 版本紀錄](https://developer.android.com/jetpack/androidx/releases/appfunctions))

**跟 pi mobile 的關係**：如果 pi mobile 能呼叫別的 app 的 AppFunctions（行事曆、筆記、訊息……），就等於有一整套系統級連接器，不用一個一個串 API。

**限制**：呼叫別的 app 需要 `EXECUTE_APP_FUNCTIONS`。在 AOSP 裡，功能旗標關閉時這個權限是 `internal|privileged`；旗標打開時是 `normal`，但仍有執行期的允許清單檢查，提供方也能再限制呼叫者。也就是說，一般側載的 agent 宣告了權限也不保證能呼叫。Gemini 的整合目前也只是給受信任測試者的私人預覽。([AOSP 權限變更](https://android.googlesource.com/platform/frameworks/base/+/0c9e20e20fb07d45765df34fc6914217b123db33%5E%21/)、[AppFunctionManager](https://developer.android.com/reference/android/app/appfunctions/AppFunctionManager))

**結論**：值得關注，但現在做不了「pi mobile 呼叫其他 app」。反過來可以做：pi mobile 自己公開 AppFunctions（例如「問 pi」「在 sandbox 跑指令」），讓 Gemini 之後能呼叫；但 Gemini 端還沒開放，現在做的實際價值很低。

## 3. Gemini Nano（ML Kit GenAI Prompt API）

**是什麼**：透過 AICore 在手機上跑 Gemini Nano，支援文字或圖加文字輸入、串流、結構化輸出（alpha）。Prompt API 還是 beta。([Prompt API](https://developers.google.com/ml-kit/genai/prompt/android)、[入門](https://developers.google.com/ml-kit/genai/prompt/android/get-started))

**限制**：

- 輸入少於 4,000 token，輸出也建議不超過 4,000 token；只有最上層的前景 app 能推論，有每個 app 的配額；bootloader 解鎖的裝置不支援。([入門](https://developers.google.com/ml-kit/genai/prompt/android/get-started))
- **S24 系列不在 Prompt API 支援清單**（清單有 S26 系列、Z Fold7）。S24 雖然內建 Gemini Nano，但只給 Google 訊息之類的系統功能用。([ML Kit GenAI 支援裝置](https://developers.google.com/ml-kit/genai)、[Google 部落格：S24](https://blog.google/products-and-platforms/platforms/android/google-ai-samsung-galaxy-s24/))

**結論**：4K 上下文跑不了 agent loop（光系統提示和工具定義就超過）。未來在支援的手機上，可以當離線時的小任務模型，例如自動幫對話取標題、摘要通知；不是現在的重點。

## 4. 讓 agent 操作畫面（Computer Use）

Gemini app 的「螢幕自動化」是 beta，只支援特定 app、特定機型和地區。開發者可以用 Gemini API 的 Computer Use 工具自己做：程式送截圖，模型回傳 `click`、`type` 等動作，但 **API 本身不給你控制手機的能力**，要自己實作執行層（官方範例是對模擬器下 ADB 指令）。([Gemini 說明](https://support.google.com/gemini/answer/16940971)、[Computer Use 文件](https://ai.google.dev/gemini-api/docs/computer-use.md))

**結論**：在手機上要自己操作其他 app，只能用無障礙服務（AccessibilityService），權限很大、風險也高。當時不建議；2026-10-25 照使用者的決定做了，見 [phone-screen.md](phone-screen.md)。

## 5. Android 17（API 37）中與 pi mobile 有關的改變

Android 17 於 2026-06-16 正式發布。([Android 17 發布](https://android-developers.googleblog.com/2026/06/Android-17.html))以下是將來把 `targetSdk` 升到 37 時要處理的：

- **區域網路權限**：連區域網路裝置要用系統的裝置選擇器，或要求新的 `ACCESS_LOCAL_NETWORK` 執行期權限。([API 37 行為改變](https://developer.android.com/about/versions/17/behavior-changes-17))我們連模型 gateway 和 relay 走的是 Tailscale 的 `100.x` 位址，需要實測是否被當成區域網路。
- **記憶體上限**：超過裝置相關記憶體上限的 app 可能被終止。([Android 17 發布](https://android-developers.googleblog.com/2026/06/Android-17.html))WebView 裡的長對話需要留意。
- **`System.load()` 載入的原生檔必須唯讀**：只影響「把 pi-env 打包進 APK」那種做法。([API 37 行為改變](https://developer.android.com/about/versions/17/behavior-changes-17))

目前 `targetSdk` 是 36，這些還不影響我們。

## 對 pi mobile 的建議

1. **手機內 sandbox**：S24 上走 Termux（或之後換支援 AVF 的手機再搬進系統 Terminal 的 Debian VM，app 端主機設為 `127.0.0.1`）。
2. **AppFunctions、Gemini Nano**：先追蹤，等穩定版與權限／裝置支援開放再評估。
3. **Android 17（`targetSdk` 37）升級前**：實測 Tailscale `100.x` 是否受 `ACCESS_LOCAL_NETWORK` 影響，並留意 WebView 長對話記憶體上限。
