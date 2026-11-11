$ErrorActionPreference = "Stop"
# why: Windows decodes a program's output with the console code page (Big5 on Chinese Windows), which mangles the UTF-8 JSON tailscale prints
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Repo = "geminixiang/pi-mobile"
$Dir = Join-Path $HOME ".pi\mobile"
$Bin = Join-Path $Dir "bin\pi-mobile.exe"
$Log = Join-Path $Dir "pi-mobile.log"
$Task = "pi-mobile"

function Fail($message) {
	Write-Host "pi-mobile: $message" -ForegroundColor Red
	exit 1
}

function Step($message) {
	Write-Host "  ✓ $message"
}

function Stop-PiMobile {
	Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
	Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
	Get-Process pi-mobile -ErrorAction SilentlyContinue | Stop-Process -Force -PassThru -ErrorAction SilentlyContinue | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
}

if ($args[0] -eq "uninstall") {
	Stop-PiMobile
	Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
	Write-Host "已移除 pi-mobile。"
	exit 0
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
	"AMD64" { "x64" }
	"ARM64" { "arm64" }
	default { Fail "還不支援 $($env:PROCESSOR_ARCHITECTURE)" }
}

$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) { $tailscale = "$env:ProgramFiles\Tailscale\tailscale.exe" }
if (-not (Test-Path $tailscale)) { Fail "這台電腦沒有 Tailscale：先到 https://tailscale.com/download 安裝並登入，手機也登入同一個帳號" }
$state = & $tailscale status --json --peers=false 2>$null | ConvertFrom-Json
if (-not $state.Self.DNSName) { Fail "Tailscale 沒有連上：打開 Tailscale 登入後再執行一次" }

Write-Host "安裝 pi-mobile"
$release = "https://github.com/$Repo/releases/latest/download"
$name = "pi-mobile-windows-$arch.exe"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
	$download = Join-Path $tmp "pi-mobile.exe"
	if ($env:PI_MOBILE_URL) {
		Copy-Item ([Uri]$env:PI_MOBILE_URL).LocalPath $download
	} else {
		Invoke-WebRequest -UseBasicParsing "$release/$name" -OutFile $download
		$sums = (Invoke-WebRequest -UseBasicParsing "$release/pi-mobile.sha256").Content -split "`n"
		$expected = ($sums | Where-Object { $_ -match "\s$([Regex]::Escape($name))$" }) -replace "\s.*$", ""
		$actual = (Get-FileHash -Algorithm SHA256 $download).Hash.ToLower()
		if (-not $expected -or $expected -ne $actual) { Fail "下載 pi-mobile 失敗，或跟發布的 checksum 不符，沒有安裝" }
	}
	$version = & $download version
	if ($LASTEXITCODE -ne 0) { Fail "下載的 pi-mobile 無法執行" }
	Step "下載 $version（windows $arch）"

	Stop-PiMobile
	New-Item -ItemType Directory -Force (Split-Path $Bin) | Out-Null
	Move-Item -Force $download $Bin
} finally {
	Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless cmd.exe /d /c `"`"$Bin`" serve >> `"$Log`" 2>&1`"" -WorkingDirectory $HOME
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "pi-mobile: the pi mobile app operates this computer over Tailscale" | Out-Null
Start-ScheduledTask -TaskName $Task

& $Bin status *> $null
if ($LASTEXITCODE -ne 0) { Fail "pi-mobile 裝好了，但沒有回應。看狀態：$Bin status，紀錄：$Log" }
Step "啟動，只聽 Tailscale；登入 Windows 時自動啟動"

Write-Host ""
foreach ($line in & $Bin status) {
	if ($line -match "^On the phone, add: (.*)$") { Write-Host "好了。在手機的 pi › 設定 › 電腦 輸入：$($Matches[1])" }
}
foreach ($line in & $Bin pair) {
	if ($line -match "^Pairing code: (\d+) \(for (\d+) minutes\)$") { Write-Host "配對碼：$($Matches[1])（$($Matches[2]) 分鐘內有效；過期了在這台電腦執行 pi-mobile pair 拿新的）" }
}
Write-Host "手機要登入同一個 Tailscale 帳號。"
