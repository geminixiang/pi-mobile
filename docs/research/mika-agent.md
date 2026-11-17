# mika：agent 怎麼「想到」去操作 App（2026-11-15）

問題來源：S24 實測，pi 的 Bot 收到「蝦皮包裹到哪了」「看一下 LinkedIn 有沒有新訊息」時，只翻了通知和簡訊，沒有打開 App（見 docs/tools.md 2026-11-15 那筆）。使用者問：是不是每次都得把指示講得很清楚。答案是不需要：mika 用架構解決這件事。下面是讀 [wangzan101/mika](https://github.com/wangzan101/mika)（Apache-2.0，commit 4387bfe）原始碼得到的，沒有執行它。

## mika 怎麼做

1. **身分就是「在 App 裡把事辦完」**。`core/src/main/resources/prompts/system/identity.md` 第一段：「Your job is to get things done for the user: complete what they asked, in the apps and services they really use」。pi 的「代你操作 App」工具原本自稱「Last resort」。
2. **入口工具一直都在，其餘用到才展開**。`capabilities/groups.md`：`phone_list_apps`、`phone_launch_app` 常駐；`phone_launch_app` 的說明寫明「打開後，讀和操作畫面的工具就會出現」（`entries/phone_launch_app.md`）。pi 要模型先自己想到「搜尋工具」，多一層。
3. **每個任務開頭附上相關的已安裝 App**。`ContextBuilder.start` 把「可用渠道」放進任務上下文（`core/agent/ContextBuilder.kt`）；`ChannelAdvisor.line`（`core/knowledge/ChannelAdvisor.kt`）依任務比對到的 App 知識，寫一行例如「京東 — app: installed (com.jingdong.app.mall), known way to do it in the app; web: jd.com」，最多 3 個。
4. **App 知識庫**。`core/src/main/resources/knowledge/apps/*/APP.md`（96 份）：前置資料有套件名、別名、網站；內文寫是什麼、介面、功能在哪（例如「訂單在『我的』→『我的訂單』，詳情裡有『查看物流』」）、已知現象。每個任務最多帶 3 份，有 token 預算（`ContextBudget`：知識層 5,000 token），並標明「參考資料可能過時，以當前畫面為準」。
5. **經驗回放**。`core/agent/RouteReplay.kt`：第一次問模型之前，若有符合的成功路線就先照做，做完或對不上再交還模型；任務結束依結局更新路線計數。重複的任務幾乎不花模型呼叫。

其他值得學的：`capabilities/phone.md` 明說「一開始螢幕是空的是正常的，那是你自己的螢幕，直接打開需要的 App」（pi 的 Bot 實測時先讀了空白的背景螢幕）；提示詞全部放在檔案裡、分層、有大小金樣（`prompts/README.md`）；`system/` 不准點名工具（測試檢查）。

## pi 要怎麼做（決定）

| # | 做法 | 為什麼 | 代價 |
|---|---|---|---|
| 1 | 每則使用者訊息比對手機上已安裝 App 的名稱和套件名，附一行「相關且已安裝的 App」（最多 3 個） | 讓模型一開始就看到「這件事可以在蝦皮裡辦」 | 只在比對到時才付，約 20–40 token |
| 2 | 常駐一個入口工具（打開 App），呼叫後自動載入讀與操作的工具，不必再搜尋 | 少一層門檻、少一到兩次呼叫 | 常駐工具定義多約 60 token |
| 3 | Bot 自己學：在某個 App 做完（或試錯後找到正確做法）就把路徑、位置、怪癖記成這個 App 的筆記，存在手機上；之後的訊息比對到這個 App 時附上（有預算，標明以畫面為準）。不預先寫任何 App 的說明 | 環境是使用者手機上真實的樣子，不會有我們寫錯或過時的說明 | 只在相關時付；筆記有數量與大小上限 |
| 4 | 成功路線記下來，下次先回放 | 重複的任務幾乎不花 token | 要處理 App 改版；之後再做 |

使用者的決定（2026-11-15）：不加預設的 App 知識，agent 自己了解環境：已安裝的 App 向系統查，操作方式從實際使用中學。mika 也有從實際操作回寫知識的機制（`AppKnowledgeLearning`），我們只取這一半。筆記是資料，不是指令。

## 做了什麼（2026-11-15）

1、2 照表做：每則訊息比對手機上實際安裝的 App 名稱和套件，加一行「Apps for this」；`phone_open_as_user` 常駐，打開 App 後自動載入讀、操作、記筆記三個工具。3：Bot 用 `phone_note_as_user` 記下在某個 App 學到的做法，存在它的技能資料裡（每個 App 一則、附當時的版本）；之後提到那個 App 的訊息附上它，標成「你自己之前的筆記，以畫面為準」，版本不同時提醒重新確認。量測見 docs/tools.md 紀錄 2026-11-15 那筆。
