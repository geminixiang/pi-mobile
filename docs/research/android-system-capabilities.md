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

1. **手機內 sandbox**：S24 上走 Termux（之前討論的方案）。之後換到支援 AVF 的手機，再把同一套 relay 搬進系統 Terminal 的 Debian VM，app 端只要把主機設成 `127.0.0.1`。兩者的 app 端程式相同，Termux 版不會白做。
2. **AppFunctions、Gemini Nano**：先追蹤，等穩定版和裝置支援再說。
3. **長任務在背景**：這比上面都實際。現在 app 進背景後 WebView 會被暫停，用前景服務可以讓執行中的 agent 繼續跑。這是 Android 早就有的正式機制，不是新能力，但它是目前解決「手機上跑長任務」最直接的做法。

## 附錄：一份「手機 agent + sandbox」技術清單的查證

2026-10-19 對照一手來源逐項查證。✅ 屬實，⚠️ 部分屬實或需要修正，❌ 查不到。

### 進程內嵌入式 agent 引擎

| 項目 | 結果 | 查證內容 |
|---|---|---|
| **PhoneBuddySDK**（APUS） | ✅ | [APUS-AI-Lab/PhoneBuddySDK](https://github.com/APUS-AI-Lab/PhoneBuddySDK)：Apache-2.0，Rust，有 C ABI 和 Swift、Kotlin 包裝。README 寫明完全不用 `std::process::Command`、`fork`/`exec`；內建純 Rust 的 busybox 風格指令（`cat`、`ls`、`find` 等，沒有 git 和 python）、`boa_engine` 的 JS 沙箱、`root_dir` 路徑限制、`web_fetch` 擋私有網段的 SSRF 防護、doom-loop 偵測（8 輪提醒、16 輪中斷）。核心改自 [xai-org/grok-build](https://github.com/xai-org/grok-build)（確實存在，Apache-2.0）。補充：2026-08 才建立，37 顆星；README 另有「1:1 模擬 Claude Code、Codex 的 HTTP header」功能，可能違反這些服務的使用條款。 |
| **agentlib**（Neul Labs，Dart） | ❌ | [官網文件](https://agentlib.neullabs.com/primitives)確實描述了 `Vfs`、`Sh`、端上模型加雲端 fallback、hooks、MCP，但文件連到的 pub.dev 套件和 GitHub repo 都回 404。目前只有文件，查不到可以安裝的版本。 |
| **Wasmer SDK（Swift）** | ⚠️ | [Wasmer 2026-09-23 公告](https://wasmer.io/posts/wasmer-sdk-swift-ios-macos)：iOS 上用隱藏的 `WKWebView` 跑 WASIX，可以跑 Python、經 Edge.js 跑 Node 相容程式。但需要 iOS 27+ / Xcode 27+，標示為實驗性；[README](https://github.com/wasmerio/wasmer-sdk/blob/main/swift/WasmerWKSDK/README.md) 說現有的 Swift v0.2.1 還不支援 iOS，實體裝置也還沒測。只有 iOS/macOS，不是 Android。原文提到的 FFmpeg、Postgres，公告裡沒有看到。 |

### WASM 解釋器沙箱

| 項目 | 結果 | 查證內容 |
|---|---|---|
| **QuickJS / QuickJS-NG 編成 WASM** | ⚠️ | 方向屬實，但兩個例子要修正。[TanStack AI Code Mode](https://tanstack.com/ai/latest/docs/code-mode/code-mode-isolates) 的 QuickJS 驅動用的是原版 QuickJS，不是 NG，可設記憶體、逾時、stack 上限。Capacitor 外掛確實有一個 [capacitor-wasm-agent-tools](https://github.com/rogelioRuiz/capacitor-wasm-agent-tools)（第三方，自稱有 fuel、記憶體、逾時限制，未經獨立稽核）。 |
| **agentOS** | ⚠️ | 是 [Rivet 的 agentOS](https://github.com/rivet-dev/agentos)：WASM 加 V8 isolate，提供 bash、git、sqlite 套件，registry 裡甚至有 Pi。但[文件](https://rivet.dev/agentos/docs/limitations/)說不能跑任意原生程式和 `apt`，而且 runtime 要跑在 Node.js 主機（加原生 sidecar）或 Rivet Cloud，[不能在瀏覽器或手機裡跑](https://rivet.dev/agentos/docs/quickstart/)。 |

### Android 系統級能力

| 項目 | 結果 | 查證內容 |
|---|---|---|
| **AppFunctions** | ✅ | 見上面第 2 節：Android 16+，Jetpack 1.0.0-alpha13，仍是預覽；跨 app 呼叫受 `EXECUTE_APP_FUNCTIONS` 和允許清單限制。 |
| **Android AISeal** | ⚠️ | [Google 2026-10-07 公告](https://blog.google/security/enabling-the-next-gen-enclave-architecture-for-on-device-ai-on-android/)：用 AVF + pKVM 的 protected VM 存放個人情境資料。但現在推出的只有「硬體隔離的個人資料儲存」；在 pVM 裡跑推論和 agent、直接用 NPU 都是未來計畫。MediaTek 只有 [Dimensity 9600 Pro](https://www.mediatek.com/products/smartphones/mediatek-dimensity-9600-pro) 明列支援；Qualcomm 只說「將會支援」，沒有列出機型。原文「MediaTek/Qualcomm 已開始支援」說得太滿。S24 本身沒有 hypervisor（見第 1 節）。 |
| **ADK for Kotlin 1.0** | ✅ | [Google 2026-09-09 公告](https://developers.googleblog.com/announcing-adk-for-kotlin-10-building-production-ready-ai-agents-in-kotlin-android-and-beyond/)，最新是 [1.4.0（10-14）](https://github.com/google/adk-kotlin/releases)。有 LiteRT-LM 端上模型（[範例模型約 2.5 GB，需 8 GB RAM](https://github.com/google/adk-kotlin/blob/main/litertlm/README.md)）、ML Kit Gemini Nano 轉接（[`GenaiPrompt`，beta](https://developer.android.com/ai/adk)）、Firebase AI Logic、`@Tool(requireConfirmation = true)` 的 HITL、`RoomSessionService` 持久化對話、`AppSearchMemoryService` 記憶。 |

### 其他方向

| 項目 | 結果 | 查證內容 |
|---|---|---|
| **Strands Box**（AWS） | ✅ | [AWS 2026-10-07 開發者預覽](https://aws.amazon.com/blogs/opensource/introducing-strands-box-ai-agent-sandboxes-powered-by-dogwood/)：OS 隔離加 Dogwood 政策語言，預設拒絕，規則可以參考過去的事件。[文件範例](https://strandsagents.com/docs/user-guide/box/)正是「讀過 `customers.csv` 後一小時內禁止外連」。但[設計文件](https://github.com/strands-agents/box/blob/main/docs/design/decisions.md)說只能指定確切路徑，沒有「敏感」標籤，也不是資料流 taint tracking。 |
| **Limrun** | ✅ | [雲端 iOS 模擬器和 Android 模擬器](https://docs.limrun.com/docs/guides/mobile-simulator-mcp)，有 hosted MCP。 |
| **Phonebox** | ✅ | [phonebox.dev](https://phonebox.dev/docs)：雲端虛擬 Android 手機，有 MCP、CLI、SDK，$0.06／分鐘。 |
| **agent-device**（Callstack） | ⚠️ | [存在](https://github.com/callstack/agent-device)，有 MCP，但它操作的是本機的模擬器或實機，不是雲端服務。 |
| **Argent**（Software Mansion） | ⚠️ | [存在](https://docs.swmansion.com/argent/docs/fundamentals/mcp-server/)，有 MCP，同樣是本機模擬器，不是雲端。 |
| **Appetize AI** | ⚠️ | [有給 agent 用的 CLI 和 REST API](https://appetize.io/ai)，但查不到官方 MCP server。 |

### 對 pi mobile 有用的發現

清單外最有用的一點：我們已經依賴的 `@earendil-works/pi-durable` 本身就有 **codemode** 工具，在 QuickJS（`quickjs-wasi`）沙箱裡跑模型寫的 JavaScript，而且重啟後能用確定性重播接續執行。`@earendil-works/pi-codemode/portable` 的 `InlineCodemodeSandbox` 不依賴 Node 內建模組，註解寫明可以在瀏覽器裡跑（`node_modules/@earendil-works/pi-codemode/dist/portable.d.ts`）。也就是說，pi mobile 不用新增任何依賴，就能在手機上（不連樹莓派）給 agent 一個可以跑程式、批次呼叫工具的 JS 沙箱。它沒有 shell 和 git，取代不了 Linux sandbox，但能處理計算、資料整理、一次呼叫很多工具這類工作。
