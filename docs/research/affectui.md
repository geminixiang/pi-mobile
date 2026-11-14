# affectUI：agent 介面元件（2026-11-15）

使用者分享 [flohoeller/affectui](https://github.com/flohoeller/affectui)，覺得裡面的元件可能對工作台有用。clone 下來讀了 README、元件原始碼和它附的 agent skill（`skills/affectui/`），沒有執行。

## 是什麼

- 「給 AI agent 用的 UI」：React 19 元件，每個一個 `.tsx`，樣式用 `<style href precedence>` 注入在元件裡，不用 Tailwind 和動畫套件；用 shadcn CLI 或 MCP 安裝，裝完就是自己的原始碼。**MIT 授權**。
- 免費、跟 agent 有關的：Tool Call Card（一行一個工具呼叫：即時計時、狀態、摘要，點開看參數和結果，錯誤可重試，一組可加總）、Decision Inbox（待決定的事，各兩個快速按鈕，回答後短暫確認再收起、計數減一）、Change Summary（改了哪些檔、加減幾行）、Progress Tracker、Thinking Loader、Email Draft、Notification Stack、Smart Recommendation、Tree View、Comment Thread、Resizable（可拖拉大小的分區）。
- **付費 Pro、不在 repo 裡**：Agent Tree、Trace Waterfall、Agent Inbox、Context Map、Agent Handoff、Agent Sequence（見 [references.md](references.md)）、Cost Waterfall、Approval Gates、Review Center。

## 不能直接搬進來

每一個都和 pi mobile 的規則衝突：樣式在元件裡（我們集中在 `styles.css`，JSX 的 `style` 只能設 CSS 變數）；用 `setTimeout` 做收起（計時器有 `EFFECTS` 上限）；有註解（禁止）；視覺語言是它自己的（我們照 DESIGN.md）；狀態用旗標組合而非判別聯集。授權允許取用，但改寫的成本和照概念重寫差不多，所以**借概念、照我們的規則重寫**。

## 值得借的概念

1. **一份 span 資料，多種畫法**（它的 agent skill 裡的「agent run」範例）：一次執行記成扁平的 span 清單（`id`、`parentId`、`kind: agent | llm | tool`、`status`、開始結束時間、tokens、成本、輸入輸出），每次更新重建一次樹；同一份資料畫成「誰派了誰」（Agent Tree）、「時間花在哪」（Trace Waterfall）、「錢花在哪」（Cost Waterfall）、「誰交給誰」（Agent Sequence）。工作後台最該先定的就是這份資料模型：手機 Bot 的回合、工具呼叫、`tell_agent` 交辦、電腦 agent 的狀態、背景 job，都能投影成 span。
2. **等人的關卡**（Approval Gates 範例）：每個「執行停下來等人」的點是一筆中斷，狀態是等待、核准、改過再核准、拒絕；改過的輸入會讓執行照新的繼續；只有一個時嵌在對話裡（我們的權限卡、問題卡），很多個執行時變成依風險排序的佇列（工作後台的「需要你」）。
3. **決策收件匣**（Decision Inbox）：每件事兩個快速答案，答完短暫顯示確認再收起、下一件自動上來、計數減一。和舞台的「需要你 1/3」同方向。
4. **一行一個工具呼叫，可以點開、重試、加總**（Tool Call Card）：對照我們的工作行（`WorkLine`），可借「錯誤可重試」和「一組加總時間」。
5. **改動摘要**（Change Summary）：電腦 agent 做完，用「改了哪些檔、加減幾行」報成果，對應工作後台的「看工作內容」。
6. **可拖拉的分區**（Resizable）：IDE 式工作台的分區大小可調。

## 下一步

工作後台設計時，先定 span 資料模型（從 pi-durable 的 entries、`TriggerDoc` 的 watch、job、電腦 agent 的讀取投影出來），再決定第一個畫面用哪種畫法。
