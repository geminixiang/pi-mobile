# Appine（mthli/appine）：在 Android app 自己的程序裡跑真的 Linux

調查日期：2026-11-18。問題：使用者給了 [mthli/appine](https://github.com/mthli/appine)。它是什麼、怎麼做到的、能不能成為 pi mobile 在手機上的 Linux 環境（[phone-linux.md](phone-linux.md) 的後續；那份建議 termux/proot，使用者還沒決定）。

怎麼知道的：
- **跑過**：在 `pimobile` 模擬器（arm64，Android 16，唯讀模式，關機後還原）裝了 [v1.0.0-1](https://github.com/mthli/appine/releases/tag/v1.0.0-1) 的 APK，在它的終端機裡打指令（下表）。沒有在 S24 上跑，也沒跑長時間工作或背景。
- **讀過**：clone 到 HEAD `c4db5db`（2026-11-18），讀了 README、`docs/design/`（README、§12、§13、§15、§16）、`AGENTS.md`、`.agents/MODULES.md`、`.agents/decisions/knowledge-loop.md`、`AndroidManifest.xml`。核心程式只看了結構，沒有逐行讀。
- 星數、日期、commit 數取自 `gh api`。

## 是什麼

- Android 上的 Linux 終端機 App，作者 Matthew Lee（mthli），AGPL-3.0，已上架 Google Play。repo 2026-11-03 建立，到 11-18 有 758 個 commit、28 星；程式約 15 萬行（核心 Rust 10.7 萬、引擎 C 與組合語言 1.4 萬、Android Kotlin 1.7 萬）。
- 一句話（作者的設計文件）：「一個可以上 Google Play 的**單一程序** Android app，用直譯器和同 ISA 的二進位轉譯器，在自己的程序裡跑**沒改過的** Alpine aarch64 程式。和 iSH 同一個想法，是它的 Android 版。」預設 Alpine 3.24，設定裡可換 Debian 13。
- 需要 Android 11 以上、64 位元 ARM。

## 怎麼做到的（讀設計文件）

| 層 | 做什麼 |
|---|---|
| 引擎（C＋aarch64 組合語言） | Tier 0 直譯器，Tier 1 同 ISA 二進位轉譯（ARM64 → ARM64，每個記憶體存取都改寫成經過軟體 MMU）。遇到 `svc`、記憶體錯誤等就停下，回一個「離開原因」給核心層 |
| 核心層（Rust） | 在使用者空間實作 Linux 6.1 的系統呼叫：行程與執行緒、訊號、記憶體、VFS、tty、網路（直接用主機的 socket，netlink 自己模擬）、namespace、cgroup |
| 檔案系統 | 不是真的目錄樹：metadata 在 SQLite，檔案內容是 `objects/<編號>`，symlink 只存在資料庫裡，所以「惡意壓縮檔用 symlink 逃出去」在結構上不可能 |
| Android 外殼（Kotlin） | 終端機（Ghostty 的 libghostty-vt）、`specialUse` 前景服務、DocumentsProvider（系統「檔案」App 看得到 Linux 裡的檔案） |

為什麼這樣做，是被 Android 的限制逼出來的（設計文件 §2）：
- Google Play 不准執行下載來的原生程式碼，只准「在虛擬機或直譯器裡跑」。所以 Alpine 的程式不能直接在 CPU 上跑，只能轉譯。
- targetSdk 29 起不能 `execve` app 資料夾裡的檔案；Android 12 起有 phantom process killer 會殺子程序。所以全部在一個程序裡，fork 也自己做。
- 他們明確否決了 PRoot 式的多程序做法：「受 phantom process killer 影響，和 Termux＋proot-distro 沒差別」（§15）。

作者量的速度（§16，在 Linux arm64 開發機上，**還沒在真機量**）：gcc 編譯約原生的 3.2 倍時間，`go build` 2.6 倍，Gradle 熱編譯 3.4–3.6 倍，Python 直譯迴圈約 4.6 倍。

不是安全沙箱（§12）：Linux 裡的程式和 App 本身之間沒有安全邊界，和 iSH、Termux 一樣。只對外開放啟動畫面和 DocumentsProvider，**沒有任何 intent 能讓別的 App 叫它跑指令**。

## 實際跑的結果（模擬器）

| 指令 | 結果 |
|---|---|
| 第一次打開 | 不用任何設定，直接是 `root@localhost` 的 Alpine shell，上方兩個提示：開通知、允許不受限的電池使用 |
| `uname -srm; nproc` | `Linux 6.1.0-appine aarch64`，4 核 |
| `apk update` | 1.4 秒 |
| `apk add python3` | 3.1 秒 |
| `python3 -c "print(sum(i*i for i in range(3000000)))"` | 0.46 秒；同一段在這台 Mac 原生 0.14 秒，約 3.2 倍。CPU 和虛擬化都不同，只能當量級參考 |
| `apk add git sqlite` | 2.3 秒 |
| `git clone --depth 1`（25 MB 的 repo） | 2.8 秒 |

## 對 pi mobile 的意思

**它解決的正是 phone-linux.md 卡住的地方**：PRoot 要靠子程序，會被 phantom process killer 殺、要處理 W^X；Appine 全部在一個程序裡、能上 Play、速度約原生的 3 到 5 倍，而且 `apk`、Python、git 實際能用。

但不能直接拿來用，有三件事要先決定：

1. **授權**：Appine 是 AGPL-3.0，pi mobile 是 MIT。把它的引擎和核心編進 pi，發佈出去的 pi 就必須以 AGPL 授權（這是 AGPL 的規定，不是推測）。要嘛 pi 改授權，要嘛不嵌入。
2. **兩個 App 怎麼合作**：Appine 刻意不讓別的 App 叫它跑指令。可行的路是**把 pi 的電腦端程式（`host/`，Go，linux/arm64）裝進 Appine 裡跑**，pi 把它當成一台已配對的電腦，透過本機的連線（127.0.0.1）連過去；兩個獨立程式透過網路溝通，不受 AGPL 影響（推論，沒有查過法律意見）。現有的斷線續傳、背景指令、`run_command` 全部沿用。要改的是：`host/tailnet.go` 現在只在 Tailscale 的 IP 上聽，需要一個只聽本機的模式和對應的配對方式。**這條路沒有試過。**
3. **使用者要多裝一個 App**：還要開通知、允許不受限的電池使用，Linux 才能在背景繼續跑。對一般使用者是一道門檻。

和使用者目前的優先順序對照：使用者說現階段重點是「助理的感受」（[references.md](references.md) § 原則），而 2026-10-31 定的方向是「手機不變成開發機器，重的工作交給電腦」。Appine 讓手機自己也能跑 Python、git，屬於「Bot 能做的事變多」，不是「讓人每天想打開」。我的建議是：**先記下來，不排進現在的工作**；等使用者決定要在手機上跑真的 Linux 時，它比 PRoot 更值得先試，試法是上面第 2 點。

## 開發流程上可以參考的

這個 repo 和 pi mobile 一樣，大部分是 coding agent 寫的（15 天 758 個 commit，`AGENTS.md`、`.agents/skills` 都是給 agent 的）。它的做法：
- **每個模組一份「地圖」**（`.agents/maps/<模組>.md`）：現在的行為、測試、已知 bug、陷阱。agent 改程式前先讀受影響模組的地圖，改完更新地圖。`.agents/MODULES.md` 把每個檔案（甚至同一個檔案裡的幾個函式）指到唯一的模組。
- **每個 commit 帶一段結構化的決定**：`MODULE`、`WHY`、`ALTERNATIVES`、`CHOSEN`、`TRADEOFFS`、`RISKS`，取代時加 `SUPERSEDES`；定期把它們濃縮成每個模組的 `.agents/decisions/<模組>.md`。
- **設計文件有一節「否決過的做法」**（§15），每一條寫為什麼不做。

和 pi mobile 的對照：pi 有 `docs/feature-map.md`（畫面的名字）、`docs/architecture.md`、規則表和 `npm run check`，但沒有「每個模組的現況和已知問題」這一層，也沒有集中的「否決過的做法」。今天兩次修正都是先沒讀清楚整條流程才補洞（背景指令的停止、錯過的排程），模組地圖正是讓 agent 先讀到整條流程的東西。是否要學，等使用者決定；學的話先從排程和背景指令兩個模組試。

## libappine.so：能不能直接載進 pi

讀了 APK 裡的 `lib/arm64-v8a/libappine.so`（`nm -D`、`objdump -p`），對照 `android/.../Native.kt` 和 `hosts/android/src/lib.rs`（HEAD `c4db5db`）。

- **一個檔案就是整台 Linux**：8.3 MB，只依賴 Android 系統的 `libc`、`libdl`、`liblog`、`libandroid`、`libjnigraphics`。rootfs 另外放在 `assets/rootfs.tgz`（4 MB），還帶了 bash、procps、bubblewrap 的 apk。
- **對外 85 個 JNI 函式**：`Native` 37 個（Linux 本身），`VtNative` 48 個（終端機畫面）。`Native` 就是一套「嵌入一台 Linux」的介面：
  - `importRootfs(store, tarball)` 建立儲存區，`start(store, tier)` 回傳一台機器的 handle，`boot(machine)` 跑 inittab；
  - `openConsole` 開一個程序內的 PTY，`spawn(machine, console, program, argv, envp)` 跑程式，`read`／`write` 讀寫輸出入，`waitFor(pid)` 拿結束碼；
  - `readFile`／`writeFile` 在不跑機器時也能讀寫檔案，`takeListens` 回報開了哪些 port，`stop` 結束。
  - 這幾個剛好對得上 pi-env 的 `ExecutionEnv`（執行指令、讀寫檔案），所以技術上 pi 可以把它包成「手機上的一台電腦」，不需要經過 `host/` 的網路協定。
- **限制（讀程式得知）**：
  - JNI 名字是靜態綁定的（`Java_io_github_mthli_appine_Native_spawn`），pi 要嘛宣告一個一模一樣叫 `io.github.mthli.appine.Native` 的類別，要嘛自己重新編譯改名。
  - 它會在載入它的程序裡裝 SIGSEGV、SIGBUS、SIGILL 的處理器（接在 ART 之後），Linux 用的記憶體和 CPU 也都算在那個程序上；預設記憶體上限是手機 RAM 的一半。放進 pi 等於 Linux 和 pi 的 WebView 同一個程序：引擎自己的 bug 會連 pi 一起帶走，跑重的編譯時也可能拖到畫面。
  - 呼叫要在背景執行緒，`read`、`write`、`waitFor` 會卡住。
- **授權（這是重點）**：把 `libappine.so` 放進 pi 的 APK 一起發佈，就是在發佈 AGPL 的程式，而且在同一個程序裡連結，pi 整個 APK 就得以 AGPL 授權並提供原始碼。從已安裝的 Appine 借它的 `.so` 來載也行不通：Android 7 起每個 App 的原生函式庫只能從自己的路徑載入（linker namespace，推論，沒試），而且授權問題一樣。

**結論**：`libappine.so` 的介面比我原本想的更適合嵌入，pi 要用它跑指令只需要包一層。卡住的只有授權。可行的路有三條，都要使用者決定：
1. pi 改用 AGPL（等於整個 pi 跟著改授權）；
2. 問作者能不能用別的授權提供函式庫（例如給 pi 一份 MIT 或商業授權）；
3. 不嵌入，維持「兩個 App、pi 的電腦端程式跑在 Appine 裡」的做法（上一節第 2 點）。
