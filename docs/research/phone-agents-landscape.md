# 手機 GUI 代理的版圖、背景操作與合規

調查日期：2026-10-30。問題：pi mobile 和 Mika（見 [mika.md](mika.md)）在整個手機代理的版圖裡落在哪裡；在背景操作第三方 App 技術上可不可行；有哪些政策與封號風險。重點放在台灣與全球的 App。

做法：從五個角度搜尋，抓了 22 個來源，拆出 102 條主張，挑 25 條做三票對抗式驗證（要 2 票反駁才剔除）：22 條確認、3 條否決，合併後剩下 10 條。每條都標了可信度。

結論先講：

- **用無障礙服務讓 LLM 自主操作手機的 App，不能上 Google Play。** 政策明文禁止用 Accessibility API「自主發起、規劃並執行動作」，也明列助理、自動化工具不算無障礙工具，不能拿 `isAccessibilityTool` 豁免。pi mobile 的 `use_phone_screen` 屬於這一類，只能側載或自行散布。
- **Google 自己的路線是「隔離的虛擬視窗」加 AppFunctions。** Gemini 在 Secure Virtual Window 裡操作單一 App，概念和 Mika 的隱藏虛擬螢幕相同，但用的是只給系統助理的特權框架。AppFunctions 像裝置上的 MCP server，但還在實驗預覽，第三方代理目前呼叫不到。
- **大型 App 的風控會把自動化環境當成異常。** 豆包手機助手 2025 年 12 月用系統級注入操作微信，使用者被強制登出，兩家銀行 App 要求先關掉它。Mika 的 shell-uid 注入和豆包很接近；pi mobile 的無障礙路線也可能遇到。
- **基準分數已經追上人類，但不代表真實 App 上的成功率。** AndroidWorld 的前沿自報約 80–87%（人類基準 80%），但它跑在模擬器和沒有風控的開源 App 上，而且分數幾乎全是自報。

## 1. 版圖：有哪些手機代理、成績如何

### 1.1 學術與開源模型（截圖 + VLM）

| 系統 | 做法 | AndroidWorld | 可信度 |
|---|---|---|---|
| 阿里 GUI-Owl-7B | 端到端 GUI 模型 | 66.4（OSWorld 29.4） | 高（論文自報） |
| 阿里 Mobile-Agent-v3 | 以 GUI-Owl 為底的多代理框架 | 73.3（OSWorld 37.7） | 高（論文自報） |
| 阿里 GUI-Owl-1.5（Mobile-Agent-v3.5，2026-02） | 同上，新版 | 8B-Thinking 71.6；32B-Instruct 69.8 | 高（論文自報） |
| 智譜 AutoGLM-Mobile（MobileRL-9B，GLM-4.1V-9B 底座） | 強化學習訓練的手機代理 | 80.2（pass@1） | 中 |

- 來源：GUI-Owl 與 Mobile-Agent-v3 見 [arXiv 2508.15144](https://arxiv.org/abs/2508.15144)；GUI-Owl-1.5 見 arXiv 2602.16855 與 [emergentmind](https://www.emergentmind.com/topics/mobile-agent-v3-5)。
- AutoGLM 的 80.2 是官方排行榜 2025-09-26 從 75.8 更新而來，MobileRL 論文（arXiv 2509.18119）也寫 80.2（[benchmarklist](https://benchmarklist.com/benchmarks/androidworld/)）。這是研究模型的成績，不一定等於出貨的 AutoGLM App。
- 以上都是作者自報，沒有獨立重現。

### 1.2 聚合排行榜的快照（可信度低）

- BenchLM（2026-10）：榜首 Qwen3.8-Omni-Flash 87.1%（[來源](https://benchlm.ai/md/benchmarks/androidworld.md)）。
- llm-stats（2026-10）：Qwen3.8 Max 85.3%，Qwen3.8 Flash／Flash-Next 84.5%（[來源](https://llm-stats.com/benchmarks/androidworld)）。這個網站自己標明 8 筆全是自報、0 筆經過驗證。
- emergentmind（2025-10）：ColorAgent 77.2%，MobileUse 62.9%，V-Droid 59.5%（[來源](https://www.emergentmind.com/topics/androidworld-and-androidlab-benchmarks)）。
- 代理系統自報的分數更高，例如 Droidrun 約 91.4%（[Droidrun blog](https://droidrun-ai.pages.dev/blog/how-we-achieved-state-of-the-art-android-world-benchmark-results)）。
- **被否決的說法**：「2026 年 9 月 Seed1.8-GUI、Gemini 3 Flash、A0 三家並列 97.4%」（1–2）；「Qwen 包辦前五名、全都 81% 以上」（0–3）。

這些只能當某個網站、某個時間點的快照，不能據此斷定誰最強。

### 1.3 AndroidWorld 測的是什麼（可信度高）

- 116 個程式化任務，分布在 20 個真實 App。環境是模擬器上的 Pixel 6、Android 13。
- 成敗由 ADB 讀 SQLite、檔案系統等系統狀態判定，不靠模型自己說。
- App 多是 F-Droid 的開源 App，加上 Chrome、設定、時鐘等 Google 或系統 App。**沒有 LINE、銀行這類有風控的商業 App。**
- 來源：論文 arXiv 2405.14573（ICLR 2025）、google-research/android_world。

所以 AndroidWorld 量的是「看懂畫面、規劃步驟」的能力，量不到真實 App 裡的登入牆、風控與封號。

### 1.4 平台方：Google Gemini（可信度中）

- Gemini 的多步驟 App 自動化在一個隔離的 **Secure Virtual Window** 裡跑，代理只看得到、只能操作任務需要的那個 App。使用者透過即時通知監看，可以查看、接手或停止任務（[Business Today](https://www.businesstoday.in/technology/news/story/geminis-agentic-era-is-here-it-can-now-automate-multi-step-tasks-on-android-apps-518098-2026-02-26)；通知監看另有 Google support 頁 16940971 佐證）。
- 據 Android Authority 拆解，底層是 Android 的 **ComputerControl** 框架：每個工作階段一個受信任的虛擬顯示器和虛擬輸入裝置，只給 ASSISTANT 角色，需要 `ACCESS_COMPUTER_CONTROL` 權限。
- 和 Mika 對照：概念相同（隱藏的虛擬螢幕、使用者可接管），機制不同。Gemini 用平台特權；Mika 用無線偵錯拉起 shell-uid helper 自己建。
- **被否決的說法**：「2026 年 2 月在 Pixel 10／Galaxy S26 以 beta 推出」（1–2）。上線範圍與時間應視為不確定。

## 2. 背景操作的技術可行性

### 2.1 AppFunctions：正規管道，但第三方還用不到（可信度高）

- 平台 API `android.app.appfunctions` 加 Jetpack `androidx.appfunctions`。官方文件說它讓 App「behave like on device MCP servers」：App 提供工具，代理不必操作畫面（[developer.android.com](https://developer.android.com/ai/appfunctions)，2026-10-22 更新）。
- 限制：
  - 需要 Android 16（API 36）以上，目前是實驗預覽。
  - 呼叫方需要 `EXECUTE_APP_FUNCTIONS` 權限，保護等級是 internal|privileged 或只給 ASSISTANT 角色。官方說實驗期「only a limited number of apps and system agents can access the entire pipeline」。
  - 截至 2026 年 5 月，與 Gemini 的整合仍是只對受信任測試者的私人預覽（另見 [9to5google](https://9to5google.com/2026/02/25/android-appfunctions-gemini/)）。
- 對 pi mobile 的意義：minSdk 已經是 36，平台版本不是問題；問題在權限。pi mobile 現在不能指望呼叫別的 App 的 AppFunctions。把 pi 設成預設數位助理（ASSISTANT 角色）之後能不能拿到這個權限，這次沒有查到可信的答案，見 §5。

### 2.2 Play 對 AppFunctions 的新規（可信度中）

- 2027-04-14 生效：開發者的 AppFunctions 不得欺騙或操縱 AI 代理、繞過安全控制，或干擾其他 App（[Play 政策](https://support.google.com/googleplay/android-developer/answer/16585319)）。
- 推論（頁面沒有明說）：一邊禁止用無障礙 API 做自主代理，一邊替 AppFunctions 訂規矩，Google 是把 AppFunctions 當成代理與 App 互動的正規管道。

### 2.3 這次沒查證到的部分

以下都沒有得到經過驗證的主張，需要另外調查或實測：

- 無線偵錯在 Android 14–17 與 One UI 上的限制：重開機或換網路後失效、Samsung 的背景限制。
- Shizuku 能不能當作比自建 ADB 更可靠的替代方案。
- 虛擬螢幕遇到 `FLAG_SECURE` 畫面的行為。
- iOS 上除了 App Intents／捷徑之外，有沒有合規的 GUI 操作途徑。

## 3. 風險與合規

### 3.1 Google Play 的無障礙政策（可信度高）

- 政策原文：「Any use of the Accessibility API that enables an app to autonomously initiate, plan, and execute actions or decisions is strictly prohibited.」這類 App 也不能申請該 API。照固定腳本跑的決定性自動化不在禁止之列。2025-10-30 的政策通知是進一步「釐清並強化」這一條（[10964491](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)、[16585319](https://support.google.com/googleplay/android-developer/answer/16585319)）。
- 豁免只給核心用途是直接支援身障者、宣告 `isAccessibilityTool=true` 的工具，而且自主功能必須服務那個核心用途。政策明列防毒、**自動化工具、助理**、啟動器、監控 App 都「不是無障礙工具」。
- 其他用到 Accessibility API 的 App，必須在 App 內明顯揭露並取得同意，也要在 Play 商店頁說明用途。
- 對兩個專案的意義：
  - pi mobile 的 `read_phone_screen` / `use_phone_screen` 讓模型自己決定點哪裡，正是政策描述的行為（政策沒寫「AI」兩字，但沒有模糊空間）。只要它在 App 裡，就不能上 Play。
  - Mika 透過 GitHub Releases 散布，本來就不上 Play；它的無障礙服務同樣用於自主操作。

### 3.2 豆包手機助手事件（可信度中，2025 年 12 月）

- 預裝在中興努比亞 M153 工程樣機上（12/1 上市，人民幣 3,499），持有系統級 `INJECT_EVENTS` 權限：讀畫面、模擬點擊，不走一般第三方無障礙服務。
- 用它操作微信的使用者被強制登出，提示「登录环境异常」。農業銀行、建設銀行 App 跳出提示，要求先關閉該 AI 工具。
- 豆包隨後下線相關能力，並協助使用者解封。微信表示沒有特別針對，是常規風控觸發。
- 來源：[第一財經](https://www.yicaiglobal.com/news/wechat-some-chinese-banking-apps-reportedly-restrict-devices-with-bytedances-new-ai-voice-assistant)，另有界面、澎湃、IT之家、Pandaily、36Kr、[每日經濟新聞](https://www.nbd.com.cn/articles/2025-12-05/4169388.html)、[OECD AI incident](https://oecd.ai/en/incidents/2025-12-07-3ee1) 等報導。2026 年另有報導說有 155 個 App 正式拒絕這類代理（[北京日報](https://news.bjd.com.cn/2026/10/15/11996628.shtml)），這條未經本次驗證。
- 對兩個專案的意義：
  - Mika 的 shell-uid helper 注入輸入、建虛擬螢幕，效果很接近豆包的系統級注入。Mika 的隨機落點和弧線滑動就是在對付這類偵測，README 也承認有封號風險。
  - pi mobile 的無障礙路線同樣可能被判為異常環境：銀行 App 常偵測「開著的無障礙服務」。
  - 這件事發生在中國生態（微信、國有銀行）。LINE、Google 和台灣的銀行、支付 App 會不會同樣處理，這次沒有找到佐證。

## 4. pi mobile 與 Mika 落在哪裡

| | pi mobile | Mika | Gemini（平台方） | 豆包手機助手 |
|---|---|---|---|---|
| 操作畫面的方式 | 無障礙服務，操作使用者自己的主螢幕 | 無障礙讀畫面＋ shell-uid helper 注入，操作隱藏虛擬螢幕 | ComputerControl 虛擬顯示器（據報導） | 系統級 `INJECT_EVENTS` |
| 需要的特權 | 開無障礙 | 開無障礙＋無線偵錯配對 | 系統 ASSISTANT 角色 | 系統預裝 |
| 能不能上 Play | 不能（只要含 `use_phone_screen`） | 不上（GitHub 散布） | 系統內建 | 系統預裝 |
| 不動畫面的替代管道 | 手機原生 API、MCP、雲端 API | 無 | AppFunctions | — |
| 已知風控事件 | 未知 | README 承認封號風險 | 未知 | 微信強制登出、銀行要求關閉 |

pi mobile 已經大量走「不操作畫面」的路線（原生 API、MCP、官方雲端 API），本來就是 Google 想推的方向（AppFunctions 就是「App 的 MCP」）。`use_phone_screen` 是補位用的。Mika 則把賭注全押在操作畫面上，技術上做得最深，但在政策與風控上也最暴露。

## 5. 還沒有答案的問題

1. LINE、Google 帳號，以及台灣的銀行、支付 App（例如街口、各銀行 App）會不會偵測無障礙服務、開發人員選項、無線偵錯或虛擬螢幕，進而限制或封鎖帳號？
2. 在 Android 14–17 與 One UI 上，「無線偵錯 + shell-uid helper + 隱藏虛擬螢幕」這條路線穩不穩？有沒有像 Shizuku 這樣更可靠的替代？
3. ComputerControl 與 AppFunctions 將來會不會開放給第三方代理？pi mobile 被設為預設數位助理後，能不能拿到這些權限？
4. iOS 上，第三方代理除了 App Intents／捷徑，還有沒有合規的 GUI 操作途徑？pi mobile 在 iPhone 上的能力上限在哪？

第 2、3 題可以在 S24 上實測：用 Mika 的 `core/adb/` 配對流程試試換網路、重開機後的行為，並查 pi 設為數位助理時 `EXECUTE_APP_FUNCTIONS` 的授予狀態。

## 6. 注意事項

- AndroidWorld 分數幾乎全是廠商或作者自報，聚合網站之間互相矛盾、收錄範圍又小（多為 Qwen）。只能說「前沿已達或超過人類基準」。
- AndroidWorld 沒有反機器人或風控，基準分數不能代表在 LINE、銀行這類 App 上的成功率。
- Gemini Secure Virtual Window 主要依據二手媒體報導，上線時間的說法已被否決一則。
- 時效性：AppFunctions 是實驗 API，權限可能放寬；Play 的 AppFunctions 新規 2027-04 才生效；排行榜每月都在變。
- Droidrun、Samsung、Apple App Intents、Project Astra 的技術機制，這次都沒有拿到經過驗證的主張。
