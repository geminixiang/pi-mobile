# 切到容器後的準備迴圈

## 現象

S24 的 Pi-mobile UI Bot 從手機切到 Mac mini 容器後，側欄及輸入停止回應。Tailscale 恢復連線後仍可重現；一次受控冷啟動後，WebView renderer 的兩次即時 `top` 採樣為 106%、101%，輸入文字未正常顯示。沒有成功送出容器開發命令，不能把這個現象歸因於 Node/npm 或容器內的工作量。

## 原因

`ComputerPicker` 每次 render 都呼叫 `Workplaces.at()`，並以回傳的 `place.host` 作為準備容器 effect 的依賴。`Workplaces.resolve()` 原本每次都重新解析 hosts JSON，因此主機內容和 key 相同，物件身分卻不同。

Effect 呼叫 `prepare()`；它立即用新的物件更新 preparing state，引起下一次 render，得到另一個 host 物件，再次觸發 effect。準備成功或失敗也會更新 state，不能終止此迴圈。`SidePanel` 的 Portal 使用 `keepMounted`，所以關閉側欄並不卸載 `ComputerPicker`。

## 修正

`Workplaces` 在建構時解析一次主機清單，`list()`、`resolve()`、`containers()` 共用這份清單，讓同一 runtime 內未改變的主機具有穩定物件身分。

設定變更本來就會關閉舊 runtime 並建立新的 runtime；新 `Workplaces` 重新解析設定。因此不需要忽略 effect 依賴、增加計時器、全域快取或修改 Drawer 的掛載方式。憑證與環境選擇規則沒有改變。

## 回歸測試

`test/contracts/computers.ts` 使用真實 `Workplaces` 與既有 Platform fixture：

- 同一設定連續解析 100 個 Bot，host 和 sandbox 身分保持相同。
- 新 runtime 的主機地址改變時，取得新的 host，舊 runtime 的 host 不受影響。
- 使用直接模式避免啟動容器橋接；這是共用解析路徑的回歸測試，不冒充完整 React 或 S24 UI 測試。

在隔離基底 `60b2b78cca03e569a669812de2241353612db5eb`，先加測試：28 項 contracts 中 1 項失敗，錯誤為主機物件內容相同但非同一 reference。套用修正後，完整 `npm run check`、`npm run build` 與 `git diff --check` 通過。

## S24 實機驗證

2026-10-25，Samsung S24，實際 App WebView。開始時另一輪 `tmp-screen` 測試仍在執行，等它結束才接手；未中止該模型回合。使用空白的 `tmp-container-prepare` Bot 排除長對話的干擾。

| 項目 | 修補前 | 修補後 |
| --- | --- | --- |
| 同一容器主機解析 100 次 | 100 次物件身分改變，斷言失敗 | 身分穩定，斷言通過 |
| 空白測試 Bot 的 renderer CPU | 110%、108%、116% | 0%、0%、1%、1%、1% |
| DevTools 操作 | 後續 Runtime.evaluate／Page.addScript 逾時 | 正常完成 |
| 手機／直接／容器切換 | 容器會持續重繪 | 三輪、共九次切換通過 |
| 側欄 | 原先關閉後仍可能卡住 | `test/side-panels.mjs` 真實觸控回歸通過 |
| 輸入框 | 原對話文字無法正常輸入 | 空白 Bot 與原長對話均可輸入、還原草稿 |
| 原長對話冷啟動 | 曾重現輸入卡住及高 CPU | 保留容器選擇，100 次解析穩定，CPU 0%、1%、0% |

CPU 是 `top -b -n ... -d 1 -o PID,%CPU,NAME` 對當次 renderer PID 的即時採樣，100% 約為一個 CPU 核心，不是整機使用率。不是採用可能保留舊 PID 的 `dumpsys cpuinfo`。短暫 rAF 探測修前也能完成，不能單靠它判定沒有迴圈。

修後透過 App 輸入自然語言，讓測試 Bot 使用目前檔案／bash 工具，只執行 `pwd; uname -s; node --version; npm --version`。實際回覆為 `/workspace/<測試 Bot>`、Linux、Node `v24.22.0`、npm `11.19.1`，無錯誤；不是由桌面替它執行。這次未進行 Git 功能開發。

### 安裝與保存

- 修補版基底：`642bac33270a5db349a39a4b6195d356df4baa63`，包含另一輪已提交的手機畫面功能；另加本次 Workplaces／contract 修正，避免覆蓋其他開發成果。
- 版本仍為 `0.6.0-dev`／600。隔離整合副本通過完整 check 與 Android build，再用 `adb install -r` 更新，沒有清資料或解除安裝。
- 修前 APK SHA-256：`876939dcf283e07891e6879687edd6cb97349a6d2a04a4d70301259459cc5a71`。
- 修後 APK SHA-256：`c4c7cc711d5fde074be50ac9e1426c510965d40c5ddd52c4454d2e65253aa3a6`；安裝後再次讀取 APK 雜湊確認相同。
- 兩個 APK 簽章憑證 SHA-256 均為 `fefa53634c4e24e63e71ce65c09f71c099bb83c2c519d444435a1a407d9bcac1`。
- 測試 Bot 已移除；原 Pi-mobile UI Bot、對話及 Mac mini 容器選擇保留。驗證當時尚未 commit、push 或公開發版。

本機原始紀錄保留於 `/tmp/pi-container-loop.NAWWhg/evidence/`：修前／後 contracts、S24 host identity、CPU、原長對話冷啟動、UI 切換、側欄觸控、容器指令結果、清理結果，以及 APK 備份。正式回歸入口為 `npm run check:contracts`；裝置回歸需在選到容器的測試 Bot 執行，不能以一般 Node 測試冒充實機驗證。
