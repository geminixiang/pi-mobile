# 人為什麼明天還想打開 App？對 pi mobile 的意思

調查日期：2026-11-18。問題：使用者說「要讓用戶每日主動想打開的 bot，才是好 bot」，做 App 要懂心理學。X、Threads、Facebook、TikTok、YouTube、Duolingo 和 AI 助理靠什麼讓人每天回來？哪些有實驗證據，哪些只是作者的模型？界線在哪？pi mobile 該怎麼做？

第 1 到 6 節和第 8 節由 gpt-6.2-astra（pi，經 Rex）讀一手資料寫成；我抽查了四個關鍵數字，都和原文一致：Duolingo KDD 2020 表 8（新手第 1／7 天留存相對 +2.2%／+2.0%）、Wohllebe 等人 2021 表 1（七週解除安裝 1.37%／5.09%／6.46%）、Brutlag 2009（100／400 毫秒少 0.20%／0.59% 搜尋）、Duolingo 連勝部落格（第 14 天留存相對 +3.3%）。第 7 節是我讀 pi mobile 程式後的對照與建議，標明出處。


## 1. 一頁結論

**收到提醒才回來、沒有提醒也主動回來、用完覺得值得，是三件事。** Duolingo 的推播實驗量到留存，YouTube 的問卷問觀看是否值得；兩者都不能單獨證明「使用者明天自己想回來」。以下的「強」只指實驗實際測到的結果；「中」指追蹤、使用紀錄或自陳資料。[Duolingo 實驗][bandit]、[YouTube 問卷][yts]

1. **有事可做｜中。** ChatGPT 近八成對話是求指引、找資訊或寫作。有證據說明人來做什麼，沒有證明哪種任務使人隔天回來。[ChatGPT 使用研究][gpt]
2. **固定情境｜中。** 把自選行為放在每天本來就會遇到的情境，動作會逐漸自然；漏一次不等於重頭開始。[Lally 等人][habit]
3. **進度看得見，下一步做得到｜強。** Duolingo 讓學習者完成一課就能延續連勝，第 14 天留存相對增加 3.3%，達成每日目標的人卻變少。[Duolingo 連勝實驗][streak]
4. **有人回應｜對發文強，對回訪未定。** 按讚回饋能改變下一次發文的時間；這不等於隨機給讚會讓人每天打開 App。[Lindström 等人][likes]
5. **下一則內容跟我有關｜對使用量強。** Facebook 和 Instagram 將推薦動態改為時間倒序後，使用時間下降；多看幾分鐘本身不是滿意度。[動態排序實驗][feed]、[YouTube 問卷][yts]
6. **提醒切合目的｜強，但限情境。** Duolingo 改選提醒文案，新手第 7 天留存相對增加 2.0%；零售 App 增發一般促銷，解除安裝率反而上升。[Duolingo][bandit]、[零售實驗][retail]
7. **介面看來好用，操作不用等｜美感對評分有證據，速度對用量有強證據。** Google 讓搜尋慢 100–400 毫秒，每人每日搜尋量少約 0.2–0.6%；美感實驗量到的主要是「覺得好用」。[Google][speed]、[提款機實驗][looks]
8. **可以照自己的意思停下來｜中。** 手機使用者原本只想傳訊，卻轉去看推薦內容時，事後較容易後悔；值得再來不必等於這次留得更久。[手機使用研究][regret]

## 2. 機制：同一個「開啟」，可能出於不同理由

### 有事可做：需求本身就是提示

「今天有一封難寫的信」不需要平台製造懸念。Chatterji 等人分類消費版 ChatGPT 對話，實用指引、找資訊、寫作合計近八成。Anthropic 分析 Claude.ai 的工作任務，將 57% 歸為人機協作、43% 歸為交給模型執行。Grok 的 DeepSearch 則讓人從一個問題開始，交由系統查找、整理資料。前兩項是用途統計，後者是功能說明；分母不同，也都不是三款助手的每日主動回訪率。[ChatGPT 研究][gpt]、[Claude 研究][claude]、[xAI 產品說明][grok]

### 固定情境：讓日常事件提醒人，而非只靠手機提醒

Lally 等人請 96 人選一件事，在固定情境下重複 12 週，例如午餐後喝水。模型估計接近個人自動化上限所需時間介於 18 至 254 天；不是每人都被追蹤了 254 天，也沒有人人適用的養成期限。漏做一次未明顯破壞形成過程。套到每日一課，「早餐後練習」是情境線索；螢幕上的連勝數字則是進度回饋，不能當成習慣已形成的測量。[Lally 等人][habit]、[Duolingo 連勝設計][streak]

### 進度與勝任感：離目標多遠，和怕不怕歸零不同

Nunes 與 Drèze 隨機發出 300 張洗車集點卡。空白八格卡和已蓋兩格的十格卡，都要再洗八次；兌獎率分別是 19% 與 34%。這支持「看得見已經起步」有助完成，不支持「一定要讓人怕失去」。Duolingo 將連勝與原訂每日目標拆開，一課便能保住天數；留存上升、目標達成下降。同一個改動，對「回來」與「做到原本想做的量」有相反結果。[集點卡田野實驗][progress]、[Duolingo A/B 測試][streak]

### 社交回應：我想看的是誰回了我

Lindström 等人分析逾百萬則貼文，並在 176 人實驗中改變按讚回饋，觀察到發文節奏隨之改變。Facebook 在 2018 年宣布提高可能帶來朋友往返討論的貼文排序；Instagram 說 Stories 會考慮過去是否常看該帳號、按讚或私訊。這解釋了為何朋友的近況會排在前面，但「可能引起回覆」是系統的預測，不是當事人覺得互動有意義的證言。[行為實驗][likes]、[Facebook 公告][fb]、[Instagram 排序說明][ig]

### 個人化與新鮮感：還有沒有一則值得看？

Guess 等人在 2020 年美國選舉期間做了三個月隨機實驗。Facebook、Instagram 使用者改看時間倒序動態後，花的時間與活動量下降。這支持排序能改變行為，不能分辨讀者是找到喜歡的內容，還是不容易停下來。下表是各平台**公布當時的設計**，不是今天的精確權重，也不是各家各做過一次留存實驗。[原始田野實驗][feed]

| 畫面 | 使用者實際遇到的選擇或預設 |
|---|---|
| X、Threads | X 的 2023 年開源版本從已追蹤與未追蹤帳號挑出候選貼文，再為 For You 排序；推播另有一套選取服務。Threads 的 For You 混合追蹤與推薦內容，Following 則只看已追蹤帳號。[X 原始碼][x]、[Threads 官方公告與更新][threads] |
| Instagram、TikTok | Instagram Reels 預測會不會看完或轉傳；TikTok 的 For You 將看完較長影片視為比創作者與觀眾同國更強的興趣訊號。兩者都不必等人手動搜尋下一部。[Instagram][ig]、[TikTok][tt] |
| YouTube | 2016 年論文區分「先挑候選影片」與「再排序」，排序納入預期觀看時間。後來 YouTube 另問觀眾影片是否值得看，四或五星才算「值得的觀看時間」，再用模型推估沒填問卷的觀看。實際評分與預測值仍應分開讀。[RecSys 論文][yt]、[YouTube 問卷說明][yts] |

### 外部提醒：通知可以補記憶，也可以打斷人

Fogg 的模型主張，動機、能力與提示要在同一刻具備；提示本身不會證明使用者有這個目標。Duolingo 的推播讓已想練習的人有機會去完成一課；若只是把更多促銷送進鎖定畫面，方向可能相反。第 3 節把文案、時間與頻率的實驗分開看。[Fogg 的模型][fogg]、[學習提醒][bandit]、[零售推播][retail]

### 流暢：減少的是等待，還是原本有用的停頓？

搜尋少等一下，是更快完成既有意圖；推薦影片接著播放，則也可能讓人偏離原本意圖。兩者都減少操作，不能都用「停留變長」判為成功。第 5 節區分主觀評分、完成時間與實際用量。[搜尋延遲實驗][speed]、[使用意圖與後悔研究][regret]

### 自主性：我能決定看什麼，也能決定不看

Ryan 與 Deci 將自主、勝任、關係列為基本心理需求，這是動機理論，不是留存公式。在產品上，Threads 的 Following 讓人排除陌生帳號推薦；TikTok 的「不感興趣」讓人修正系統推斷。功能存在不表示人人都找得到，也不證明留存上升；可另問「最後做的是不是本來想做的事」。[自我決定理論][sdt]、[Threads][threads]、[TikTok][tt]、[手機使用研究][regret]

## 3. 通知：何時送、送幾則、送什麼

| 問題 | 誰測了什麼 | 能下的結論 |
|---|---|---|
| 送什麼？ | Duolingo 的 KDD 2020 論文比較兩週：對照組也收到提醒，從適用文案中隨機選；實驗組依適用條件、過去效果與近期是否重複來選。新手第 1／7 天留存相對增加 2.2%／2.0%，日活躍人數增加 0.5%，完成課數增加 0.4%。[原論文，表 8][bandit] | 測的是**怎麼選文案**，不是要不要送。演算法的成效訊號是提醒後兩小時內有沒有完成一課，不是有沒有點通知；其中也有人本來就會練習。[原論文][bandit] |
| 何時送？ | Okoshi 等人在 Yahoo! JAPAN 的 Android App 比較立即顯示和等到使用活動有空檔再顯示；21 天、687,840 人。後者從**顯示後**算起的反應時間縮短 49.7%。[原實驗][timing] | 不是消息從發生到被看到快了一半。另一個 237 人隨機實驗發現，全機通知每天分三批送，比照常送更有專注感與掌控感；全關者反而較怕錯過。三個時段不是每個 App 每天三則的配額。[Fitz 等人][batch] |
| 多少算太多？ | Wohllebe 等人對同一零售 App 的 17,500 人測試七週。一般促銷從不送、每週一則到每週兩則，七週解除安裝率分別為 1.37%、5.09%、6.46%；頻率愈高，單則直接開啟率也愈低。[原論文，表 1][retail] | 即使多送能再換到一些點擊，也要計入從此收不到的人。此處測的是未個人化促銷，不能用來訂使用者自設會議提醒的上限。[零售研究][retail] |

**作業系統的規範，不是效果實驗。** Apple 建議等到第一次排定提醒等具體時機再問授權，通知也應避免在鎖定畫面暴露敏感內容。Android 13 起，一般新裝 App 的通知預設關閉；Google 建議在使用者能理解用途時再問。讓人先決定哪件事值得通知，比一開始就問「要不要全部允許」更符合這兩份指引。[Apple 權限][apple]、[Apple 通知設計][hig]、[Android 通知權限][android]

## 4. 第一次使用：先讓人判斷這裡有沒有我要的東西

**TikTok 先解決「還沒追蹤任何人，要看什麼」。** 初次可以勾選興趣；略過也能先看熱門影片。第一次看完、重播或按讚就能提供下一輪推薦的線索。不填偏好並不等於沒有起點。[TikTok 冷啟動說明][tt]

**Duolingo 先解決「我的程度可以從哪裡開始」。** 官方流程仍要選語言、回答目標等問題，再從基礎開始或做分級測驗；建立個人檔案的明確好處是保存、同步進度。它並非零設定，官方說明也不足以斷言所有版本都能在註冊前做完第一課。兩者的共同點是很早就讓人看影片或接觸語言題目，而不是先要求建立社交圈；這是流程比較，不是首日留存的因果估計。[Duolingo 新手指南][onboard]、[TikTok][tt]

## 5. 美感與流暢：好看、好用、用得多，要分開測

Tractinsky 等人的模擬提款機實驗有 124 人納入分析。美感與主觀易用性評分在使用前後的相關分別為 0.66、0.71；但較難操作的版本，任務平均仍需 37.5 秒，較容易的只需 23.5 秒。美觀可以改變印象，不能代替計時測試。[原論文][looks]

Google 的 Jake Brutlag 則實際讓搜尋結果慢下來。在四至六週的實驗中，多等 100 毫秒，每人每日搜尋量平均少 0.20%；多等 400 毫秒，少 0.59%。這裡量到行為，而不只是「我不喜歡等」。數字適用於該搜尋實驗，不是每款 App 的留存換算率。[Google 實驗報告][speed]

## 6. 反面證據與界線

**不確定的回饋不是「每天會回來」的定律。** Ferster 與 Skinner 研究的是不同增強時程下的動物反應；Eyal 將變動獎賞放進產品循環，是作者的模型。人類按讚實驗支持回饋影響發文，並未直接比較「固定／隨機給獎」對隔天無提示開啟的效果。這是外推缺口，不是動物研究複驗失敗。真正的複驗警訊是意志力耗竭：Hagger 等人有 23 個實驗室、2,141 人參加預註冊複驗，效果量 *d*＝0.04，95% 信賴區間為 −0.07 至 0.15，不足以用這套程序斷言「意志力用完了」。[增強時程原著][skinner]、[Eyal 原著][eyal]、[人類回饋實驗][likes]、[多實驗室複驗][ego]

**把使用者自己的評價放回結果。** 一週的手機截圖、訪談與體驗取樣研究追蹤 17 名 Android 使用者；原本有明確用意，後來轉看推薦或評論，是受訪者談到後悔的情境。樣本不足以估計全體比例，但說明同一段「有使用」可能違背本人原意。YouTube 的「值得看嗎」比只計秒數多問了一件事，卻仍不是對整段使用有無後悔的完整測量。[原始使用者研究][regret]、[YouTube][yts]

**同意變多，不一定代表選擇變好。** Luguri 與 Strahilevitz 的實驗中，輕度操弄介面使接受可疑訂閱的機率超過對照組兩倍，強度高時接近四倍，且引起反感。歐盟《數位服務法》第 25 條禁止適用的線上平台以欺騙或操弄介面實質妨礙自由、知情的決定；英國 ICO《兒童設計準則》第 13 項要求不得誘使兒童交出不必要的資料或調低隱私保護。後者針對兒童，不是全面禁止成人使用連勝或推播。[暗黑模式實驗][dark]、[DSA 第 25 條][dsa]、[ICO 設計準則][ico]

**判斷私人資料的用途，而非只看有沒有按過允許。** GDPR 第 5 條列出目的限制與資料最小化；Google Workspace 政策要求只取功能所需的權限。依此區分：讀行事曆來提醒本人指定的會議，是完成委託；拿同一筆行程挑最容易把人叫回來的空檔，是另一個目的。可拒絕或撤回、不把信件主旨放在鎖定畫面，是具體的信任界線。[GDPR][gdpr]、[Workspace 資料政策][workspace]、[Apple 通知設計][hig]

**研究判準（本文建議）：** 分開記錄無提醒日的主動開啟、原訂任務完成率、事後回答「值得嗎」的比例，以及靜音與解除安裝率。若要估計推播多帶來多少回訪，需要可比較的不發送組；只排除「點通知進來」不夠，看到提醒的人也可能稍後自行點圖示。沒有要辦的事而不開，不必算成失敗。[通知實驗的歸因限制][bandit]、[解除安裝研究][retail]、[使用意圖研究][regret]

## 7. 對 pi mobile 的意思

使用者的標準（[references.md](references.md) § 原則）：打開就有東西在等，打開本身舒服。下面把研究對照 pi 現在的做法；「現在」一欄是讀程式得知（檔案寫在裡面），沒有在手機上量過使用者每天開幾次。

| 機制（證據強度） | pi 現在 | 差距與建議 |
|---|---|---|
| 有事可做：打開時已經有它主動做好的事（中） | 晨報、13:00 與 18:00 巡視寫在 `src/skills/builtin/morning-brief/SKILL.md`，但只有使用者在第一次對話回答「好」才建立（`src/agent/bots.ts` 的 `OFFER`）。信件只有連了信件的 MCP 服務才讀得到 | 使用者每天打開 Grok Bot 的理由之一就是它主動看新信。pi 的晨報預設是關的，信件也常讀不到。先在使用者的 S24 上用一週量：晨報有沒有被看、哪幾行讓人點進去 |
| 固定情境：把行為綁在每天本來就會發生的事上（中，Lally 等人） | 晨報固定 08:00 | 「起床後第一次拿起手機」「關掉鬧鐘」比固定時刻更像生活裡的線索；pi 已經有事件觸發（充電、耳機等，`src/triggers/`）。先量使用者實際幾點第一次解鎖，再決定 |
| 在空檔送（Okoshi 等人：顯示後反應快 49.7%） | 巡視的通知由 agent 判斷要不要送，23:00 到 08:00 不送 | 送的時刻改成使用者剛結束一段使用、或剛解鎖時。需要知道手機的使用狀態，先查 Android 能給到什麼 |
| 通知送什麼、送多少（強，Duolingo、Wohllebe） | 只在需要使用者時才送，沒有就安靜（同上 SKILL.md） | 方向對。補上：使用者說「這不重要」之後永遠不再提（Duet 的評論在這點被罵），並記錄每則通知有沒有被打開、有沒有被關掉，才知道哪種內容讓人回來 |
| 第一次使用就看到價值（流程比較，TikTok、Duolingo） | 第一次要先設定模型供應商；第一次對話結尾問晨報，不管對話在談什麼（2026-11-18 在 S24 兩次測試都出現在不相關的任務後面） | 第一個價值應該來自使用者自己的資料（Grok Bot 的做法，見 [grok-bot.md](grok-bot.md)）：例如第一次打開就從行事曆和通知找出一件今天要注意的事。晨報提議放在這之後，而不是接在不相關的回答後面 |
| 進度看得見（強，Nunes 與 Drèze；Duolingo） | 事項有狀態（`src/items/`），但沒有「今天幫你處理了什麼」 | 打開時先看到「今天替你看過 12 則通知，2 件要你決定」。這是回饋，不是要使用者害怕失去的連勝 |
| 速度（強，Brutlag）與美感（評分，Tractinsky） | 已經在 S24 上量效能（docs/development.md § 效能量測），使用者說外觀也算體驗 | 照舊；第一畫面出現前的等待最值得量 |
| 自主與後悔（中，手機使用研究；暗黑模式實驗） | 寄信、付款前要確認（確認卡、權限卡） | 成功的標準不是用得久，而是「有沒有辦到原本想辦的事」和「值得嗎」。pi 握有信件和行事曆，用私人資料挑「最容易把人叫回來的時機」就越界了；資料只用來完成使用者交辦的事 |

### 建議的順序

1. 先量，不寫程式：在使用者的 S24 上記一週，每天有沒有在沒收到通知時自己打開 pi、晨報有沒有被看、哪則通知被點、哪則被嫌煩。同一週對照 Grok Bot。
2. 依結果挑一件做：多半是「打開就有東西在等」（晨報預設開，或第一次使用就從使用者的資料找出一件事），因為它同時對應研究最強的兩點（內容切合目的、進度看得見）和使用者自己的 Grok Bot 經驗。
3. 量的方法照第 6 節最後一段：沒有通知的日子是否主動打開、原訂的事有沒有辦完、事後覺得值不值得、通知被關掉或解除安裝的比例。只存在手機上。

## 8. 來源清單

- **心理機制與反證：** [Lally 等人：習慣形成][habit]；[Nunes 與 Drèze：既有進度][progress]；[Lindström 等人：社交回饋][likes]；[Ryan 與 Deci：自我決定理論][sdt]；[Fogg 行為模型][fogg]；[Ferster 與 Skinner 原著][skinner]；[Eyal 的 Hooked 模型][eyal]；[Hagger 等人：預註冊複驗][ego]。
- **使用行為與介面實驗：** [Guess 等人：動態排序][feed]；[Tractinsky 等人：美感與易用性][looks]；[Brutlag：搜尋延遲][speed]；[手機使用後悔研究][regret]；[Luguri 與 Strahilevitz：暗黑模式][dark]。
- **學習與通知：** [Duolingo KDD 2020][bandit]、[連勝 A/B 測試][streak]、[新手流程][onboard]；[Okoshi 等人：可打斷時機][timing]；[Fitz 等人：分批通知][batch]；[Wohllebe 等人：促銷頻率][retail]；[Apple 授權][apple]、[通知設計][hig]、[Android 授權][android]。
- **平台原始資料：** [X 開源程式庫][x]、[Threads][threads]、[Facebook][fb]、[Instagram][ig]、[TikTok][tt]、[YouTube RecSys 2016][yt]、[YouTube 滿意度問卷][yts]；[ChatGPT 用途研究][gpt]、[Claude Economic Index][claude]、[Grok DeepSearch][grok]。
- **法規與資料政策：** [歐盟 DSA][dsa]、[GDPR][gdpr]、[英國 ICO 兒童設計準則][ico]、[Google Workspace 開發者政策][workspace]。

[bandit]: https://research.duolingo.com/papers/yancey.kdd20.pdf
[yts]: https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/
[gpt]: https://www.nber.org/papers/w34255
[habit]: https://doi.org/10.1002/ejsp.674
[streak]: https://blog.duolingo.com/improving-the-streak/
[likes]: https://doi.org/10.1038/s41467-020-19607-x
[feed]: https://doi.org/10.1126/science.abp9364
[retail]: https://doi.org/10.21511/im.17%282%29.2021.10
[speed]: https://services.google.com/fh/files/blogs/google_delayexp.pdf
[looks]: https://doi.org/10.1016/S0953-5438(00)00031-X
[regret]: https://arxiv.org/abs/2410.11354
[claude]: https://www.anthropic.com/research/the-anthropic-economic-index
[grok]: https://x.ai/news/grok-3
[progress]: https://doi.org/10.1086/500480
[fb]: https://about.fb.com/news/2018/01/news-feed-fyi-bringing-people-closer-together/
[ig]: https://about.instagram.com/blog/announcements/instagram-ranking-explained
[x]: https://github.com/twitter/the-algorithm
[threads]: https://about.fb.com/news/2023/07/introducing-threads-new-app-text-sharing/
[tt]: https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you
[yt]: https://research.google.com/pubs/archive/45530.pdf
[fogg]: https://www.behaviormodel.org/
[sdt]: https://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf
[timing]: https://doi.org/10.1109/PERCOM.2017.7917856
[batch]: https://www.kushlev.com/s/2019-Fitz-Kushlev-etal-2019.pdf
[apple]: https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications
[hig]: https://developer.apple.com/design/human-interface-guidelines/notifications
[android]: https://developer.android.com/develop/ui/views/notifications/notification-permission
[onboard]: https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo/
[skinner]: https://www.bfskinner.org/product/schedules-of-reinforcement-pdf/
[eyal]: https://www.nirandfar.com/hooked/
[ego]: https://doi.org/10.1177/1745691616652873
[dark]: https://doi.org/10.1093/jla/laaa006
[dsa]: https://eur-lex.europa.eu/eli/reg/2022/2065/oj/eng
[ico]: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/13-nudge-techniques/
[gdpr]: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
[workspace]: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
