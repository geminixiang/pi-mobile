# ego-browser：Bot 在電腦上怎麼用瀏覽器

2026-10-23 在這台 Mac mini 上實測：ego lite 0.6.0.12（Chromium 154.0.8037.44、內嵌 Node v24.21.0，`ego-browser --version`），skill 指南 v2.1.0。問題：Bot 直接操作使用者的電腦時，提示叫它遇到網站就用 ego-browser（`src/agent/sandbox/sandbox.ts:126`）。它實際怎麼運作、輸出多大、需要電腦提供什麼、pi mobile 該怎麼提示它。

實驗只開過 example.com，在自己建立的 task space（id 88）裡，最後 `finish({ keep: [] })` 關掉（回傳 `closedSpace: true`）。沒有登入任何網站，沒有動使用者的 space。

## 它是什麼

- `ego-browser` 是 ego lite（Chromium 改的瀏覽器）附帶的命令列程式，不是獨立的瀏覽器。`~/.local/bin/ego-browser` 是一個 symlink，指向 `/Applications/ego lite.app/.../Versions/0.6.0.12/Helpers/ego-browser`，由 Developer ID 簽章（`codesign -dv`：`com.citrolabs.ego.ego-browser`，TeamIdentifier `JGQLC6YQYJ`，hardened runtime）。
- 指令只有 `skill`、`upgrade`、`import`、`nodejs` 四種（`ego-browser --help`）。所有瀏覽器操作都是寫一段 JavaScript 交給 `ego-browser nodejs`（heredoc、`-e` 或 stdin）。
- **腳本不在 CLI 裡執行**：截圖檔名裡的 pid（`ego-browser-shot-72103-1.png`）是 `ego Helper (Node)` 的 pid，它的父程序是 ego lite 主程式（`ps -axo pid,ppid,comm`）。CLI 只是把腳本送過去、把輸出接回來；它用 Mach `bootstrap_look_up` 找到 ego lite 的 `ego_cli bootstrap`，再用 Mojo 管道溝通（`strings` 裡有 `bootstrap_look_up`、`Failed to connect to ego_cli bootstrap`、`ego/components/ego_cli/nodejs_repl_session.cc`）。所以指南說腳本不在 shell 的工作目錄、也拿不到 shell 的環境變數，檔案路徑一律要絕對路徑（skill 輸出第 91–98 行）。
- ego lite 沒開時，CLI 會自己啟動它（`strings`：`base/mac/launch_application.mm`、`Failed to start ego lite`）；這點沒實測（沒有關掉使用者的瀏覽器）。
- 它刻意只提供一組小 API，看起來像 Playwright 但不是；沒有的功能用 `page.evaluate()` 或 `page.cdp()`（skill 輸出 § Run browser scripts）。
- skill 資料夾裡的 `learnings/`（github、google、x-com）是各網站的筆記和 `manifest.json` 描述的小工具（例如 `get_open_issues`），用的是 `ctx.openOrReuseTab`、`ctx.js` 這種跟上面不同的介面（`~/.agents/skills/ego-browser/learnings/github/tools/open-issues.js`）。v2.1.0 的指南完全沒提到它們，Bot 不需要。

## 執行模型

### TaskSpace、round、Page

- **一個使用者目標用一個 TaskSpace**。建一次、印出 `spaceId`，之後每一輪都回到同一個（skill 輸出第 122 行）。
- **每次呼叫都是新的 Node 程序**：JS 變數不會留下來，但 space、分頁和 Page 標籤會（第 133 行）。所以 Bot 每一輪開頭都寫 `const task = await taskSpace(88)` 或用名字。
- **名字是唯一的**：`taskSpace(name)` 遇到同名、屬於 agent 的 space 就沿用它，不會再建一個（第 125 行；`help("taskSpace")`）。換句話說，**兩個 Bot 取了同一個名字就會共用同一個 space**。名字屬於使用者的 space 時會失敗，錯誤是 `EGO_TASK_SPACE_NAME_IN_USE`。
- 新的 space 從 Page `p1` 開始；之後的 Page 依序是 `p2`、`p3`，標籤是永久的。`task.page(label)` 只是 lazy handle，不會建 Page，也不檢查它存不存在（`help("TaskSpace.page")`）。
- 卡住、逾時、遇到意外頁面時，不准另開 space 來繞過，要在原本的 space 裡處理，不行就停下來問使用者（第 130 行）。
- `listTaskSpaces()` 會列出 agent 和**使用者**的 space（名稱、`ownership`、`profileId`）。實測這台 Mac 上有一個使用者的 space，名稱看得出使用者在做什麼。所以 Bot 看得到使用者在 ego lite 裡做的事。
- space 用的是瀏覽器 profile 的 cookie，跟使用者自己的分頁共用。所以 Bot 會以使用者的身分登入各網站，這就是提示裡說的 "sign in with the user's accounts"。清 cookie 或快取的三個指令（`Network.clearBrowserCookies`、`Network.clearBrowserCache`、沒帶 `browserContextId` 的 `Storage.clearCookies`）會清掉**整個 profile**，而且救不回來（`references/clearing-state.md:3-14`，作者實測一個 profile 有 3478 個 cookie，分屬 1161 個網域）。

### 結束：finish 和 keep

- 成功時呼叫 `await task.finish({ keep: [] })`，只能呼叫一次，要放在最後一輪的最後（第 516 行）。之後不能再操作那些 Page。
- `keep` 只在使用者要求、或結果必須留在瀏覽器給使用者看時才用（第 523–529 行）。使用者自己開的分頁受保護：如果還有，`keep: []` 不會關掉整個 space（第 533 行）。
- 實測的回傳：`{"spaceId":88,"closedSpace":true,"keptManagedLabels":[],"closedManagedLabels":["p1"],"preservedUnmanagedCount":0}`。
- 因為使用者控制、或發生錯誤而停下時，**不要**呼叫 `finish()`。

### 交給使用者

- 遇到權限詢問、裝置選擇這類瀏覽器自己的對話框，或需要使用者操作（登入、驗證碼）時：`await task.handOff()`，結束這一輪，告訴使用者要做什麼。使用者回覆後，用 `takeOverTaskSpace(id)` 接回同一個 space，再用 `task.userPage()` 拿到使用者最後停的分頁（第 486–500 行）。
- 使用者接手、或 space 不再屬於 agent 時要停，不能重試或繞過（第 486 行）。
- `claimTaskSpace()`、`takeOverTaskSpace()`，還有清整個 profile，都要先得到使用者同意（`references/clearing-state.md:62`）。
- **跟 pi mobile 的落差**：這套交接假設使用者就坐在那台電腦的瀏覽器前。pi mobile 的使用者通常拿著手機、人不在電腦旁邊。交接時 Bot 要說清楚：到哪台電腦、在 ego lite 的哪個 space（名稱）、做什麼，做完回到手機說一聲。

## 輸出有多大

### snapshot

- 純文字，縮排的無障礙樹（accessibility tree）。第一行是 Page 和 space 的狀態，例如 `[p1 "Example Domain" | space "pi-mobile research example"(88): 1 managed, 0 untracked — p1* "Example Domain"]`。
- 可以操作的節點帶著 ref 和 locator，例如 `anchor [ref=1, loc=href:https://iana.org/help/example-domains, url=…]`。之後用 `@1` 或 `loc=…` 操作它。
- **預設只抓目前的 viewport**（`scope: "only_within_viewport"`），其他選項是 `full_page` 和 `subtree`（加上 `root: "@12"`，例如只看某個 iframe）（`help("page.snapshot")`）。
- **長的文字節點會被截斷**：example.com 上，沒被截斷的最長一行是 169 bytes；超過的都在約 200 bytes 處被切掉，後面加 `...`，而且照 byte 切，會切斷多位元組字元（阿拉伯文、俄文的那兩行結尾是 `�...`）。UTF-8 的中文一個字 3 bytes，所以**每個文字節點大約只留 66 個中文字**。snapshot 適合用來找要點的元素，不適合讀文章。
- 實測大小：example.com 的 snapshot 是 1,176 字元，`full_page` 也一樣（整頁都在 viewport 裡）；加上 `includeActionMarks`、`includeStableLocator` 也沒變。同一頁 `document.body.innerText` 是 917 字元。
- 頁面變了，snapshot 不會等它穩定；要先 `waitForURL`、`waitForSelector` 或 `waitForFunction`（skill 輸出第 236–240 行）。

### screenshot

- 寫成 PNG 檔，回傳路徑；沒給 `path` 就放在系統暫存資料夾。實測 viewport 1652×883 CSS px，PNG 87,518 bytes（`sips`）。選項：`fullPage`、`clip`（CSS px 的矩形）、`scale`、`raw`（`help("page.screenshot")`）。
- 暫存資料夾是使用者自己的 `$TMPDIR`（`/var/folders/…/T/`），Bot 可以用 `read` 讀進來。pi-durable 的 `read` 對圖片的上限是 2000×2000 px、4.5 MB（`node_modules/@earendil-works/pi-durable/dist/tools/image-processor.js:1`），所以全頁截圖可能超過。

### 讓手機上的模型少讀一點

指南本身就要模型省著看：每次只拿足以決定下一步的最便宜的狀態，snapshot 和 screenshot 不要兩個都拿（第 212–214 行）；可以連著做的動作放在同一次呼叫裡，最後才印一次 snapshot（第 225–231 行）。pi mobile 可以再加上：

1. **要讀內容時用 `page.evaluate()`，只回傳需要的欄位，並限制筆數和長度**（例如 `.slice(0, 20)`、`innerText.slice(0, 4000)`），不要用 snapshot 讀文章（中文會被截斷，見上面）。
2. **只在要點選時才拿 snapshot**，預設 viewport 就好，不要 `full_page`；iframe 用 `subtree`。
3. **截圖用 `clip`** 只截相關的區域，或縮小後再 `read`；能用 snapshot 回答的就不要截圖。
4. **`ego-browser skill` 的輸出約 23 KB、550 行**（`wc -c`），大約 6k tokens，每段對話會讀一次。其中 PowerShell、cmd、`.mjs` 檔案那一段（第 38–82 行，約 1.9 KB）在 Mac 上用不到。它還在 pi-durable bash 的上限內（保留最後 2000 行或 50 KB，`dist/tools/bash.js:103`），所以不會被截斷。
5. 每次呼叫，stderr 都會多一行 `[ego-browser:notice] Ego Lite update is available…`（約 190 bytes），直到使用者更新為止。指南要模型在任務結束後問使用者要不要 `ego-browser upgrade`（第 539 行）。

## 需要電腦提供什麼

- **只有 macOS 和 Windows**：安裝腳本只支援 macOS（`scripts/install.sh` 檢查 `uname -s` 是 `Darwin`），Windows 用官網的安裝程式（`references/install.md:21,38-40`），沒有 Linux 版。安裝後要使用者在 GUI 裡完成 onboarding，`ego-browser` 才會出現在 `~/.local/bin`（`references/install.md:36`）。
- **PATH**：launchd 給 `pi-mobile serve` 的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`（`launchctl print gui/<uid>/dev.pi-mobile`）。在乾淨環境下（`env -i HOME=$HOME zsh -l -c 'command -v ego-browser'`），這台 Mac 的 login shell 找不到 `ego-browser`。不過 `loginShell` 會在 PATH 最後補上 `$HOME/.local/bin`（`host/main.go:268`），所以 Bot 的 `command -v ego-browser` 找得到。
- **從 launchd 啟動的程序也連得到**：透過這台 Mac 的 `pi-mobile serve` 的 `/exec`，執行 `ego-browser nodejs -e '… listTaskSpaces() …' < /dev/null`，成功回傳。Mach bootstrap 屬於使用者的 GUI session，`dev.pi-mobile` 是 `gui/<uid>` 裡的 LaunchAgent，所以在同一個 session 裡。**容器模式**下，Bot 在 Linux 容器裡，碰不到主機的 Mach 服務，這條路不通。提示也只在直接模式才提到 ego-browser（`sandbox.ts:126`，`containerDescription` 沒有提）。
- **stdin 一直開著時，它會卡住**：`-e` 模式下，如果 stdin 是一條沒關閉的 pipe，CLI 會等到 stdin 結束才離開（`sleep 8 | ego-browser nodejs -e …` 花了 8.1 秒；`< /dev/null` 只要 0.14 秒）。透過 `/exec` 呼叫時也一樣：stdin 是那條 WebSocket，不加 `< /dev/null` 就會卡到逾時。Bot 的 bash 走的是 pi-env，它的子程序 stdin 是 `Stdio::null()`（`pi/packages/env/daemon/src/exec.rs:200-203`），所以 Bot 不會遇到。但如果以後 pi mobile 自己透過 `/exec` 呼叫 ego-browser，就要記得加上 `< /dev/null`。
- **砍掉 CLI，腳本還是會跑完**：先啟動一個腳本（等 4 秒後寫一個檔案），1 秒後對 CLI 送 SIGTERM（CLI 結束碼 8），結果 5 秒後檔案還是寫出來了。腳本在 ego lite 的 Node helper 裡執行，不在 pi-env 用 `setsid` 開的程序群組裡（`exec.rs`、`sys/unix.rs:270`）。所以 **bash 逾時或使用者按停止，都停不下已經送出的瀏覽器動作**。另外，`page.evaluate()` 沒有 timeout 選項（skill 輸出 § Page JavaScript and CDP）。
- **macOS 權限**：截圖和輸入都透過 CDP 在瀏覽器裡面做，不需要 `pi-mobile serve` 的螢幕錄製或輔助使用權限。腳本讀寫檔案（`setInputFiles`、`saveAs`、`screenshot({ path })`）的是 ego lite 的 helper，所以讀「文件」「桌面」這類保護資料夾時，macOS 會把詢問算在 ego lite 頭上，不是 pi-mobile（推論，依據是程序的父子關係，沒有實際觸發過）。`keyboard.paste()` 會借用系統剪貼簿，貼完再還原（skill 輸出 § Visual pages）。
- **速度**：一次 `ego-browser nodejs -e 'console.log(1)'` 約 0.1 秒（`time`）。在同一個 space 裡 snapshot、evaluate、`listTaskSpaces`、`finish`，加起來 13 ms。所以跑一輪的成本主要是模型，不是瀏覽器。

## pi mobile 該怎麼提示

現在的提示（`sandbox.ts:126`）只有一句：找得到就先跑 `ego-browser skill`、照著做，不要在螢幕上點瀏覽器。照上面的結果，建議改成這樣（模型提示用英文）：

```
For websites, use ego-browser when `command -v ego-browser` finds it (macOS and Windows only): run `ego-browser skill` once per conversation and follow it.
Name your task space "pi <bot name>: <goal>" so another bot never resumes it; print its spaceId and reuse it every round.
Read page content with page.evaluate() returning only the fields you need, capped (slice lists and text); use snapshot() to choose what to click, since it truncates long text; screenshot only with clip, and only when the page has no useful DOM.
The user is usually away from this computer, on their phone: before handOff(), say exactly what to do, on which computer, in which ego lite space; resume with takeOverTaskSpace after they reply. Never claim the user's own spaces or clear cookies without asking.
Stopping a command does not stop a browser script already sent: keep each script short and bounded.
Finish with task.finish({ keep: [] }) unless the user wants the page left open.
```

其他要做的：

- 在 `docs/tools.md` 量這段提示的成本，加上第一次跑 `ego-browser skill` 的那 6k tokens（`test/device/tool-cost.sh`），再決定要不要改成 pi mobile 自己附一份精簡版。精簡版比較省，但指南是跟著 ego lite 版本走的（SKILL.md 要模型每次 upgrade 後重讀），自己附的版本可能跟裝著的對不上。
- `/info` 可以回報有沒有 `ego-browser`、版本多少，手機就能在 Bot 面板顯示，提示也可以直接寫有沒有，不必讓模型自己 `command -v`。
- space 和 Page 標籤留在 ego lite 裡，不在對話裡。對話壓縮後，印過的 `spaceId` 可能不見了，但只要名稱是固定的，`taskSpace(name)` 還是能接回同一個 space（第 125 行）。
