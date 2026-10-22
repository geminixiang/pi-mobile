#!/bin/sh
# Install pi-host: lets pi mobile on your phone operate this computer over Tailscale, as you.
#   curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh
# It listens on this computer's Tailscale address only and answers only devices of your own Tailscale account.
# Runs as you, at login (launchd on macOS, systemd --user on Linux). Remove: the same command with `-s uninstall`.
set -eu

REPO="geminixiang/pi-mobile"
DIR="$HOME/.pi/host"
BIN="$DIR/bin/pi-host"
LABEL="dev.pi-mobile.host"

say() { printf '%s\n' "$*"; }
fail() { say "pi-host: $*" >&2; exit 1; }

os=$(uname -s)
case "$os" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) fail "還不支援 ${os}" ;;
esac
case "$(uname -m)" in
	arm64 | aarch64) arch=arm64 ;;
	x86_64 | amd64) arch=x64 ;;
	*) fail "還不支援 $(uname -m)" ;;
esac

stop() {
	if [ "$os" = darwin ]; then
		launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	else
		systemctl --user disable --now pi-host.service 2>/dev/null || true
	fi
}

if [ "${1:-}" = uninstall ]; then
	stop
	rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/.config/systemd/user/pi-host.service"
	rm -rf "$DIR"
	say "已移除 pi-host。"
	exit 0
fi

tailscale=""
for candidate in "$(command -v tailscale 2>/dev/null || true)" /Applications/Tailscale.app/Contents/MacOS/tailscale /usr/bin/tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do
	if [ -n "$candidate" ] && [ -x "$candidate" ]; then
		tailscale=$candidate
		break
	fi
done
[ -n "$tailscale" ] || fail "這台電腦沒有 Tailscale：先到 https://tailscale.com/download 安裝並登入，手機也登入同一個帳號"
dns=$("$tailscale" status --json --peers=false 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$dns" ] || fail "Tailscale 沒有連上：打開 Tailscale 登入後再執行一次"

mkdir -p "$DIR/bin"
release="https://github.com/$REPO/releases/download/pi-host"
url="${PI_HOST_URL:-$release/pi-host-$os-$arch}"
say "下載 pi-host（${os} ${arch}）…"
curl -fsSL "$url" -o "$BIN.new" || fail "下載失敗：${url}"
if [ -z "${PI_HOST_URL:-}" ]; then
	expected=$(curl -fsSL "$release/pi-host.sha256" | awk -v f="pi-host-$os-$arch" '$2 == f { print $1 }')
	actual=$( (sha256sum "$BIN.new" 2>/dev/null || shasum -a 256 "$BIN.new") | cut -d' ' -f1)
	[ -n "$expected" ] && [ "$expected" = "$actual" ] || { rm -f "$BIN.new"; fail "下載的檔案跟發布的 checksum 不符，沒有安裝"; }
fi
chmod 755 "$BIN.new"
"$BIN.new" --version >/dev/null 2>&1 || fail "下載的 pi-host 無法執行"
stop
mv "$BIN.new" "$BIN"

if [ "$os" = darwin ]; then
	plist="$HOME/Library/LaunchAgents/$LABEL.plist"
	mkdir -p "$HOME/Library/LaunchAgents"
	cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$BIN</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$DIR/pi-host.log</string>
	<key>StandardErrorPath</key><string>$DIR/pi-host.log</string>
</dict>
</plist>
EOF
	launchctl bootstrap "gui/$(id -u)" "$plist"
else
	unit="$HOME/.config/systemd/user/pi-host.service"
	mkdir -p "$(dirname "$unit")"
	cat > "$unit" <<EOF
[Unit]
Description=pi-host: pi mobile operates this computer over Tailscale

[Service]
ExecStart=$BIN
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable --now pi-host.service
	if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
		say "沒有登入時也要能用的話，執行：sudo loginctl enable-linger $(id -un)"
	fi
fi

# Ask it as the phone will: over this computer's Tailscale address, which pi-host answers for its own user.
ip=$("$tailscale" ip -4 2>/dev/null | head -n 1)
ready=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
	if curl -fsS -m 3 "http://$ip:4790/info" >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep 1
done
if [ -z "$ready" ]; then
	say "pi-host 裝好了，但還沒回應。看紀錄：tail $DIR/pi-host.log"
	exit 1
fi

name=${dns%%.*}
say ""
say "好了。在手機的 pi › 設定 › 電腦 輸入：${name}"
say "手機要登入同一個 Tailscale 帳號。"
if [ "$os" = darwin ]; then
	say "這台 Mac 接著會問「pi-host 想要取用桌面、文件、下載項目」：按允許，Bot 才看得到這些資料夾。"
	say "Bot 第一次截圖時也會問一次螢幕錄製。"
fi
