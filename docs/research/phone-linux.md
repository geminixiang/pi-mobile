# 調查：手機上的 Linux 環境（取代 just-bash）

2026-11-10。問題：just-bash 不是真的 Linux，長的 bash 又會卡住對話；能不能在 Android 和 iOS 上都有一個「能 `apt`／`apk`、能跑 Python、Node」的 Linux 環境。標準（使用者訂的）：**不追求真正的隔離，只要一個 Linux 環境；秘密最好像電腦的容器模式一樣，由外面的代理補上，環境裡只看到假的 key**。

這份是書面調查：讀了原始碼、README 和文件（附出處），**沒有在手機上跑過任何一個候選**。星數、授權、日期取自 `gh api`。

## 平台限制

- **iOS**：app 不能執行自己下載的原生程式，也不能開子程序；只准直譯，或在 WebKit 裡跑 JS／WebAssembly（WebKit 的 JIT）。PRoot 在 iOS 上不可能。
- **Android**：可以開子程序，但 pi mobile 的 targetSdk 是 36，Android 10 起 app 不能 `execve` 自己資料夾裡的檔案（W^X）。DSH Go 是降到 targetSdk 28 才跑起來（[dsh-go.md](dsh-go.md)）。PRoot 放在 jniLibs（可執行的 nativeLibraryDir），rootfs 裡的程式靠它的 loader 載入，理論上可行，**要實測**。
- 兩個平台都能跑的只有 WebView 裡的 WebAssembly。

## 候選

**Android 原生**
- [termux/proot](https://github.com/termux/proot)：Termux 為 Android 改的分支（`link2symlink` 等），proot-distro 用的就是它；GPL-2.0，以子程序執行。rootfs 用 [proot-distro](https://github.com/termux/proot-distro) 發佈的 Debian／Ubuntu／Alpine。上游 [proot-me/PRoot](https://github.com/proot-me/PRoot) v5.5.0（2026-10）偏一般 Linux。

**WebAssembly（兩個平台共用）**

| 專案 | 授權 | 跑什麼 | 要不要 SharedArrayBuffer | 網路 | 判斷 |
|---|---|---|---|---|---|
| [v86](https://github.com/copy/v86) | BSD-2，23.7k 星，2026-10-30 | 完整的 32 位元 x86 Linux（Alpine 有 `apk`），x86→wasm JIT | 不用（推論：單執行緒） | 模擬網卡，後端可接 `wisp`、`wsproxy`、`fetch` | **唯一可能兩邊都能跑的完整 Linux**；沒有 x86_64，速度遠低於原生 |
| [container2wasm](https://github.com/container2wasm/container2wasm) | Apache-2.0，v0.8.5（2026-11-04） | 任何 Docker 映像（Debian、`apt`、x86_64、riscv64） | **要** | 瀏覽器裡的網路堆疊「只在 Chrome 測過」 | 最真，但要跨來源隔離；QEMU 版預留 2.3 GB 記憶體，iPhone 可能被系統殺掉 |
| [Wasmer SDK](https://github.com/wasmerio/wasmer-sdk) | 改過的 MIT（月活破百萬要標示 Wasmer） | 編成 wasm 的 bash、coreutils、Python 3.13，不是 Linux | **要** | `http`、`wisp` | 最快，但沒有套件管理器，只能用他們 registry 裡的套件 |
| [linux-wasm](https://github.com/joelseverin/linux-wasm) | GPL-2.0 | Linux 核心直接編成 wasm，只有 BusyBox | **要** | 沒有 | 作者說「遲早會當掉」，先觀望 |
| Pyodide、almostnode | MPL-2.0、MIT | 只有 Python／只有 Node 的 API | — | fetch | 補充用，不能取代 shell |
| CheerpX／WebVM、BrowserPod | 引擎是商業授權 | x86 Debian | — | — | 引擎不開源，排除 |

- **SharedArrayBuffer 是分水嶺**：Android WebView 一個 app 只有一個渲染程序，過去沒辦法跨來源隔離（[說明](https://hermit.chimbori.com/help/known-issues)）；有二手消息說 WebView 156 加了允許清單，沒驗證。iOS 上 `capacitor://` 的回應加 COOP／COEP 能不能讓頁面變成 `crossOriginIsolated`，也沒確認（[Capacitor #5502](https://github.com/ionic-team/capacitor/discussions/5502)）。
- 沒找到任何一個在手機 WebView 上的效能數字。

## Cloudflare Sandbox SDK 可以借的

讀了 [cloudflare/sandbox-sdk](https://github.com/cloudflare/sandbox-sdk) 的 1.0（main）和 0.x（v0 分支）原始碼。1.0 拿掉了常駐的 bash session、背景程序管理和串流，改成無狀態的 `exec(argv)`，把「背景程序」放在一個範例裡用檔案記；從建立到第一個指令的中位數從 4.0 秒降到 648 毫秒（[遷移說明](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/)）。

1. **背景程序記在磁碟上的資料夾，不靠連線**（`examples/process-workspace/src/processes.ts`）：`pid`、`stdout.log`、`stderr.log`、`exit-code`（先寫暫存檔再改名），狀態是 `starting | running | exited | lost`（pid 不在、又沒有結束碼就是 lost）。手機睡著或斷線後，讀檔就知道發生什麼。`run_command` 的 job 已經接近這樣，可以收斂成同一個格式，PRoot 也照用。
2. **bash 等一段時間就轉背景**：Cloudflare 有 `waitForExit(timeout) → timed-out`，但他們自己的 MCP（7 個工具）和 OpenAI 轉接都沒接上 LLM，逾時就是死路。我們可以讓 `bash` 先等 20–30 秒，沒結束就回「還在跑，是 job:X，跑完會叫醒你」，沿用現有的叫醒機制。
3. **從位移重播再跟上**：`tail -n +1 -F --pid`，5 秒心跳偵測對方離開；斷線後從第 N 個 byte 接著讀。
4. **整個程序群組一起結束**：`setsid` 加 `kill -- -pgid`，用 shell 內建的 `kill`（精簡的 rootfs 可能沒有 `kill` 執行檔），結束碼 143 是訊號不是當掉。
5. **跑著的程序不會讓任何東西保持醒著**：他們在有工作時每 60 秒設一次鬧鐘。對應到 Android：只在有 job 時開前景服務，最後一個結束就關。
6. **秘密留在外面**：環境裡的 key 是 `"provided-by-worker"` 這種佔位字串，外面的代理依網站補上真的憑證、其他網站一律 403（`runner/outbound.ts`）。和我們電腦容器模式的 mitmproxy 是同一個想法。
7. **加 API 前先做「刪除測試」**：只是包一層的功能（等 port、轉送 HTTP、終端機）不放進公開介面。

## Cloudflare 的另外兩個專案

- **[cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os)**（Apache-2.0，2026-11-10 的 HEAD）**不用 just-bash，也沒有任何 shell**。commit `59a7428`（2026-09-03）寫明「NO containers, NO bash, NO git CLI. It's entirely JS/TS in a Durable Object」。agent 的工具是讀寫改檔、`grep`、`webFetch`，加上一個 `executeCode`（在 Dynamic Worker 裡跑 JS），外面的系統（GitHub、Slack…）一律是程式碼裡的 binding，憑證留在各自的 gatekeeper Worker，agent 的程式碼拿不到。它也用 `@earendil-works/pi-agent-core` 和 `pi-ai`。
- **[cloudflare/computer](https://github.com/cloudflare/computer)**（MIT，2026-11-05）**才是用 just-bash 的那個**，也最接近我們的問題：
  - 一份權威的檔案系統（Durable Object 的 SQLite），上面掛多個執行後端，`workspace.runtime.exec(source, { backend })` 是唯一入口：`worker-shell`（just-bash）、`container-shell`（真的 Linux，用 FUSE 把同一份檔案掛進容器，`computerd` 同步回來）、`codemode`（JS 模組）。`runtime.backends()` 列出有哪些。
  - 工具一套，名字固定（`read`、`ls`、`find`、`grep`、`write`、`edit`、`delete`、`exec`），有 pi 的版本（`@cloudflare/computer/tools/pi-ai`）；`exec` 帶 `backend` 參數，但他們提醒「選後端是路由，不是授權」，要由主機端的允許清單決定。
  - 輸出照 pi 的 bash 工具：超過 2000 行或 64 KiB 只回最後一段，完整輸出逐 byte 存成工作區裡的檔案，結果裡附路徑。
  - 每次執行有 id，事件帶遞增的 `seq`，可以 `getExec({ id, after: seq })` 接回；容器換了一台時回 `EEXEC_LOST`，不把舊 id 套到新程序；傳送中斷時說「可能已經開始」，不重送。just-bash 後端刻意不支援接回和背景執行，要背景就用容器或 codemode。
  - `examples/egress`：同一個網址經三種後端，用同一套 `none`／`all`／自訂的外連政策。
  - 對我們的意義：**跨平台的答案不是找一個兩邊都能跑的 Linux，而是同一份 Bot 資料夾、同一套工具，底下的後端依平台不同**：just-bash（兩邊都有）、QuickJS code mode（兩邊都有）、PRoot Debian（Android）、電腦的 pi-env（兩邊都能連）。iOS 少一個後端，不是另一套做法。

## 建議

- **Android：termux/proot ＋ Debian rootfs，裡面跑 pi-env 的 daemon**，手機把它當成本機的一台電腦（`RemoteExecutionEnv`），斷線續傳、`run_command` 都沿用。秘密：app 在 PRoot 外開本機代理補憑證，Debian 裡設 `HTTPS_PROXY` 和信任它的 CA；真的 key 放在 Keystore 加密的儲存，不放明文檔案（PRoot 不是安全邊界，程序找得到 app 的資料夾）。
- **iOS：先維持 just-bash，重的工作交給電腦**；v86 是唯一可能在 iOS 上跑完整 Linux 的開源方案，要實測速度和記憶體再決定。網路經過 WebView 裡的 JS，同一處就能補憑證。
- **兩邊共用的部分放在 pi-env 這一層之上**：工具和 Bot 只看到「這個環境」，平台差異只在誰提供它。

## S24 實測：PRoot＋Debian（2026-11-10）

一個獨立的測試 APK（`dev.geminixiang.prootpoc`，targetSdk 36，在 app 自己的程序裡用 `ProcessBuilder` 執行），S24、Android 17（SDK 37）。proot 用 Termux 套件庫的 `proot 5.1.107.102`、`libtalloc 2.5.0`、`libandroid-shmem 0.7`（aarch64），把 `libtalloc.so.2` 的依賴改名後放進 jniLibs；rootfs 是 docker 匯出的 `debian:trixie-slim` arm64（103 MB 的 tar，proot-distro 現在也是從 Docker 映像拉）。

| 步驟 | 結果 |
|---|---|
| app 執行 nativeLibraryDir 裡的 `libproot.so --version` | 成功，SELinux 網域是 `untrusted_app_34`（和 pi mobile 一樣），48 毫秒 |
| 系統的 `tar` 把 rootfs 解到 app 私有目錄 | 0.5 秒，104 MB；唯一一個 hard link（`perl5.40.1`）建不起來：Android 不准 app 建 hard link，所以 proot 要開 `--link2symlink` |
| proot 裡跑 Debian 的 bash | **成功，W^X 沒擋**：`uname -m` 是 aarch64，Debian 13，模擬的 root，94 毫秒 |
| `apt-get update`、`apt-get install python3` | 5 秒、14 秒，`python3` 3.13.5 能跑；`/usr` 變成 136 MB。要加 `-o APT::Sandbox::User=root`，`/etc/resolv.conf` 要自己寫 |
| 2 分鐘的工作（每 5 秒寫一行時間），回到桌面、關螢幕，**沒有前景服務** | 約 15 秒後整個 app 連同 proot 被系統凍結（`isFrozen=true`），喚醒螢幕後才繼續 |
| 同上，**開著前景服務**（`specialUse`，安靜的通知） | 沒被凍結，24 次都寫完；關螢幕時 `sleep 5` 拉長成 7–13 秒，喚醒後回到 5 秒，全程 185 秒 |

結論：在 targetSdk 36、Android 17 上，PRoot＋Debian 能用，`apt` 正常；背景的長工作要靠前景服務，只在有工作時開。APK 只多 proot 這幾個檔案（約 380 KB），rootfs 第一次使用時下載。

## 要先實測的

1. **S24，PRoot**：targetSdk 36 下 proot＋Debian 能不能跑（W^X）；`apt install python3`（hard link、dpkg、網路）；跑 2 分鐘的指令、關螢幕會不會被殺；rootfs 和 APK 增加多少。
2. **S24 和 iPhone，WebView 能力**：`typeof SharedArrayBuffer`、`crossOriginIsolated`、256 MB／1 GB／2 GB 的 `WebAssembly.Memory`。這一步決定 container2wasm 和 Wasmer 有沒有機會。
3. **S24 和 iPhone，v86＋Alpine**：冷開機和從快照恢復的時間、`python3 -c 'print(1)'`、`apk add python3`（經電腦上的 wisp 轉送）、WebView 程序的記憶體、聊天畫面在 VM 忙的時候會不會卡（`test/perf/run.ts`）。
