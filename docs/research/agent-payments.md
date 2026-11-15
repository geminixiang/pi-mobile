# Agent 怎麼不替你花錢：成熟產品與開源專案（2026-11-16）

問題來源：付款／送出前確認的設計（使用者要求：跟錢有關的用寫死的規則擋，不經過 LLM，確認使用者意願優先）。先看別人怎麼做。

標記：**文件**是廠商自己寫的；**二手**是新聞或第三方整理；**程式**是讀了原始碼（repo@commit 檔案:行）；**推論**是沒有查證的推斷。openai.com 有幾頁抓不到（403），ChatGPT agent 的 system card 只看到二手整理。

## 商業產品

| 產品 | 怎麼認出「錢」 | 認出來之後 | 出處 |
|---|---|---|---|
| OpenAI Operator | 模型自己判斷（訓練出來的），購買前會問的比例 92%；銀行轉帳直接拒絕（94%） | 在對話裡問；敏感網站在你離開時暫停 | 文件：cdn.openai.com/operator_system_card.pdf |
| ChatGPT agent | 同上，金融交易的確認率據稱 99.9–100% | 卡號、密碼由你在接手模式輸入，不進模型 | 二手：belitsoft.com/news/chatgpt-agent-openai-20250717 |
| OpenAI Agents API 瀏覽器 | 每個新網站要你核准；文件明說核准網站「不等於」每一步都會確認，確認工具「要靠 agent 自己去叫」 | 登入資料走專用事件，不進模型 | 文件：developers.openai.com/api/docs/guides/agents-api/tools/computer-use |
| Anthropic Claude in Chrome | 「不論權限，一律不做」購買和金融交易；另有分類模型在每個動作執行前檢查 | 拒絕 | 文件：support.claude.com/en/articles/12902446 |
| Google Gemini 在 Android 上操作 App（「on-device virtual phone environment」，跟 pi 的背景螢幕同一類） | 「完成交易」「輸入密碼或付款資料」列為 Gemini「可能暫停、請你接手」的步驟（由模型決定何時暫停） | 說明寫「最後一步（例如確認叫車、下單）」由你完成；但 Pixel 10、Galaxy S26 目前不能接手，只能停止任務 | 文件：support.google.com/gemini/answer/16940971（2026-11-16 讀原文） |
| Google Chrome auto browse | 「完成金融交易」 | 由你接手；另有一個只看動作、不看網頁內容的檢查模型 | 文件：support.google.com/chrome/answer/16821166；二手：thehackernews.com 2025-12 |
| Gemini Agent 排程 | — | 文件承認：你不在線上時，可能來不及阻止它做出不想要的動作 | 文件：support.google.com/gemini/answer/16596215 |
| Apple App Intents（WWDC26 347） | **系統**依動作類型（schema 的刪除、送出…）和當下狀態判斷風險，不是模型 | 系統跳確認；可要求解鎖，開發者只能加嚴 | 文件：developer.apple.com/videos/play/wwdc2026/347 |
| Google AP2、Visa、Mastercard | 付款端：使用者在可信的介面用生物辨識簽「授權」；agent 拿到的是代幣，不是卡號 | 無人值守只能在事先簽好的上限內 | 文件：ap2-protocol.org/ap2/flows |
| Perplexity Comet | 模型判斷 | 失敗案例：在假商店自動填入已存的信用卡並結帳，沒有問 | guard.io/labs/scamlexity-… |

## 開源專案

| 專案 | 機制 | 任何語言都能用嗎 | 出處（程式） |
|---|---|---|---|
| Open-AutoGLM | 模型在點擊上標 `message="重要操作"`，程式就停下問；登入、驗證碼用 `Take_over` 交給人 | 只看模型認不認得；換模型就不可靠 | zai-org/Open-AutoGLM@86f5538 `phone_agent/config/prompts.py:26-27`、`actions/handler.py:139-145` |
| mika | 三層：模型宣告 `request_confirmation`；程式在每個寫入動作前用**詞表**判斷（支付、付款、下单、结算…，加上 `[¥￥$＄]\d` 和 `\d元`）；付款一律 `hand_to_user`；排程中一律拒絕 | 否：詞表幾乎全是簡體中文 | wangzan101/mika@65c65b0 `core/gate/IrreversibleDetector.kt:42-48,108`、`core/action/ConfirmDecision.kt:69,92` |
| Skyvern | 停下後由模型分類停的原因，付款類的停止不能被推翻 | 是（模型判斷） | Skyvern-AI/skyvern@fa49c52 `forge/taskv3/goal_check.py:499` |
| browser-use、droidrun | 機密資料用佔位符，模型看不到；限制能去的網域 | 不處理付款 | browser-use@e717df1 `agent/service.py:224`；droidrun@e340042 `system.jinja2:73` |
| mobile-use、mobile-mcp、UI-TARS、midscene | 沒有付款關卡（UI-TARS 只有通用的 `call_user`；midscene 明確不支援 `Take_over`） | — | 各 repo，見研究暫存 |

## 平台本身給的訊號（不靠語言）

- **密碼欄位**：Android `AccessibilityNodeInfo.isPassword()`、iOS `secureTextField`。標的是登入和 PIN，不是錢，但付款密碼也在內。（文件）
- **生物辨識**：Android 的 BiometricPrompt 是 SystemUI 的視窗（`AuthContainerView.java:757-776`，FLAG_SECURE）；Apple Pay 要按側邊鍵加 Face ID，XCTest 按不了。這是作業系統內建、agent 過不去的人工關卡。（文件）
- **FLAG_SECURE**：截圖會失敗（pi 已處理：`PhoneScreenPlugin.kt:173`），無障礙樹照樣讀得到；沒有 API 直接說「這是安全視窗」。（文件＋推論）
- **Android 14 的 `accessibilityDataSensitive`**：App 標了的元件，對 `isAccessibilityTool="false"` 的服務（pi 就是，`phone_screen_service.xml:11`）直接不出現；我們只能從「不見了」間接知道。（文件）
- **信用卡的 autofill 提示**：無障礙服務讀不到。（文件）
- **Google Play 付款、Google Pay 的視窗**：在哪個程序、有沒有標記，還沒在實機上確認。（推論）
- **貨幣符號**：Unicode Sc 類 64 個符號，能認「NT$ 1,200」「1.234,56 €」「₹ 500」；認不出「CHF 12.00」「12,00 zł」和「元／円／원」（這些是文字）。ISO 4217 代碼由 `Intl.supportedValuesOf("currency")` 提供（Node 實跑 162 個）。（實跑）

## 共同的做法

1. **線畫在最後一下**：下單、付款、轉帳。逛、比價、加購物車都不擋。
2. **跟 pi 最像的產品（Gemini 在 Android 上操作 App）把最後一下交給你按**，不是你同意後由 agent 按；不過何時暫停是模型決定的，不是寫死的規則。卡號、密碼一律由人輸入，不進模型。
3. **「最後那個按鈕」沒有平台訊號**：每一家都靠模型判斷，再加一個檢查模型。寫死的規則只存在於有結構可抓的地方：網站或類別清單、Apple 的動作類型、密碼管理器、付款端的簽章。
4. **無人值守沒人解決**：Google 承認可能來不及阻止；Amazon 照事先設的門檻直接買；只有 AP2 用「事先簽好的上限」設計。
5. **最可靠的防線是 agent 根本拿不到付錢的工具**：沒有卡號、沒有密碼、付款要生物辨識。

## pi 要怎麼做（建議，待使用者決定）

- **錢的最後一下由你按，不由 Bot 按**：程式擋下後打開小螢幕交給你接手（Gemini 在 Android 上的做法，但我們用寫死的規則觸發，不靠模型決定何時暫停；接手功能已經有了）。這比「你同意後 Bot 按」更嚴，也省掉「同意的是不是這一下」的比對。
- **寫死的規則用不靠語言的訊號**：按鈕上有金額（貨幣符號或 ISO 代碼）、密碼欄位、系統視窗（生物辨識、付款視窗）、截圖被擋；不學 mika 的詞表。
- **最後那個按鈕上沒有金額時**，學 AutoGLM 和 mika：模型在步驟上宣告「這一下會花錢」，程式照樣擋下交給你；再用判斷模型補漏。這一層是補強，不是保證，要在文件裡寫明。
- **無人值守**：碰到錢一律停下、回報，比 Google 嚴。
- **沒查證的**：Google Play 付款和 Google Pay 視窗在 S24 上長什麼樣子、XCTest 看不看得到 Apple Pay 的視窗。實作前先在實機探測。
