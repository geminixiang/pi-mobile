#!/bin/sh
# Install pi-mobile on a computer: the pi mobile app on your phone can then operate it over Tailscale, as you.
#   curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh
# It listens on this computer's Tailscale address only and answers only devices of your own Tailscale account.
# `pi-mobile serve` runs as you, at login (launchd on macOS, systemd --user on Linux). Remove: the same command with
# `-s uninstall`.
set -eu

REPO="geminixiang/pi-mobile"
DIR="$HOME/.pi/mobile"
BIN="$DIR/bin/pi-mobile"
LABEL="dev.pi-mobile"
UNIT="pi-mobile.service"

say() { printf '%s\n' "$*"; }
fail() { say "pi-mobile: $*" >&2; exit 1; }

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
		systemctl --user disable --now "$UNIT" 2>/dev/null || true
	fi
}

if [ "${1:-}" = uninstall ]; then
	stop
	rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/.config/systemd/user/$UNIT"
	rm -rf "$DIR"
	say "已移除 pi-mobile。"
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
"$tailscale" status --json --peers=false 2>/dev/null | grep -q '"DNSName": *"[^"]' || fail "Tailscale 沒有連上：打開 Tailscale 登入後再執行一次"

mkdir -p "$DIR/bin"
release="https://github.com/$REPO/releases/download/computer"
url="${PI_MOBILE_URL:-$release/pi-mobile-$os-$arch}"
say "下載 pi-mobile（${os} ${arch}）…"
curl -fsSL "$url" -o "$BIN.new" || fail "下載失敗：${url}"
if [ -z "${PI_MOBILE_URL:-}" ]; then
	expected=$(curl -fsSL "$release/pi-mobile.sha256" | awk -v f="pi-mobile-$os-$arch" '$2 == f { print $1 }')
	actual=$( (sha256sum "$BIN.new" 2>/dev/null || shasum -a 256 "$BIN.new") | cut -d' ' -f1)
	[ -n "$expected" ] && [ "$expected" = "$actual" ] || { rm -f "$BIN.new"; fail "下載的檔案跟發布的 checksum 不符，沒有安裝"; }
fi
chmod 755 "$BIN.new"
"$BIN.new" version >/dev/null 2>&1 || fail "下載的 pi-mobile 無法執行"
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
	<key>ProgramArguments</key><array><string>$BIN</string><string>serve</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$DIR/pi-mobile.log</string>
	<key>StandardErrorPath</key><string>$DIR/pi-mobile.log</string>
</dict>
</plist>
EOF
	launchctl bootstrap "gui/$(id -u)" "$plist"
else
	unit="$HOME/.config/systemd/user/$UNIT"
	mkdir -p "$(dirname "$unit")"
	cat > "$unit" <<EOF
[Unit]
Description=pi-mobile: the pi mobile app operates this computer over Tailscale

[Service]
ExecStart=$BIN serve
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable --now "$UNIT"
	if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
		say "沒有登入時也要能用的話，執行：sudo loginctl enable-linger $(id -un)"
	fi
fi

# Asked as the phone will: over this computer's Tailscale address, which it answers for its own user.
for _ in 1 2 3 4 5 6 7 8 9 10; do
	if "$BIN" status >/dev/null 2>&1; then
		say ""
		"$BIN" status | sed -n 's/^On the phone, add: /好了。在手機的 pi › 設定 › 電腦 輸入：/p'
		say "手機要登入同一個 Tailscale 帳號。"
		if [ "$os" = darwin ]; then
			say "這台 Mac 接著會問「pi-mobile 想要取用桌面、文件、下載項目」：按允許，Bot 才看得到這些資料夾。"
			say "Bot 第一次截圖時也會問一次螢幕錄製。"
		fi
		exit 0
	fi
	sleep 1
done
say "pi-mobile 裝好了，但還沒回應。看狀態：$BIN status，紀錄：tail $DIR/pi-mobile.log"
exit 1
