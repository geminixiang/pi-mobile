#!/bin/sh
set -eu

REPO="geminixiang/pi-mobile"
DIR="$HOME/.pi/mobile"
BIN="$DIR/bin/pi-mobile"
APP="$HOME/Applications/pi-mobile.app"
LABEL="dev.pi-mobile"
UNIT="pi-mobile.service"
SIGNING="$DIR/signing"
IDENTITY="pi-mobile (local)"

say() { printf '%s\n' "$*"; }
step() { printf '  ✓ %s\n' "$*"; }
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
	rm -rf "$DIR" "$APP"
	say "已移除 pi-mobile。"
	exit 0
fi

tailscale=""
for candidate in "$(command -v tailscale 2>/dev/null || true)" /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/bin/tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do
	if [ -n "$candidate" ] && [ -x "$candidate" ]; then
		tailscale=$candidate
		break
	fi
done
[ -n "$tailscale" ] || fail "這台電腦沒有 Tailscale：先到 https://tailscale.com/download 安裝並登入，手機也登入同一個帳號"
TAILSCALE_BE_CLI=1 "$tailscale" status --json --peers=false 2>/dev/null | grep -q '"DNSName": *"[^"]' || fail "Tailscale 沒有連上：打開 Tailscale 登入後再執行一次"

say "安裝 pi-mobile"
release="https://github.com/$REPO/releases/latest/download"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() {
	url="${3:-$release/$1}"
	curl -fsSL "$url" -o "$2" || return 1
	[ -n "${3:-}" ] && return 0
	expected=$(curl -fsSL "$release/pi-mobile.sha256" | awk -v f="$1" '$2 == f { print $1 }')
	actual=$( (sha256sum "$2" 2>/dev/null || shasum -a 256 "$2") | cut -d' ' -f1)
	[ -n "$expected" ] && [ "$expected" = "$actual" ]
}
fetch "pi-mobile-$os-$arch" "$tmp/pi-mobile" "${PI_MOBILE_URL:-}" || fail "下載 pi-mobile 失敗，或跟發布的 checksum 不符，沒有安裝"
chmod 755 "$tmp/pi-mobile"
version=$("$tmp/pi-mobile" version 2>/dev/null) || fail "下載的 pi-mobile 無法執行"
step "下載 ${version}（${os} ${arch}）"

sign() {
	keychain="$SIGNING/pi-mobile.keychain-db"
	if [ ! -f "$keychain" ]; then
		mkdir -p "$SIGNING"
		chmod 700 "$SIGNING"
		/usr/bin/openssl rand -hex 24 > "$SIGNING/password"
		chmod 600 "$SIGNING/password"
		/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -subj "/CN=$IDENTITY" \
			-addext "basicConstraints=critical,CA:false" -addext "keyUsage=critical,digitalSignature" \
			-addext "extendedKeyUsage=critical,codeSigning" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
		/usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$IDENTITY" -passout pass:p -out "$tmp/id.p12"
		security create-keychain -p "$(cat "$SIGNING/password")" "$keychain"
		security set-keychain-settings "$keychain"
		security unlock-keychain -p "$(cat "$SIGNING/password")" "$keychain"
		security import "$tmp/id.p12" -k "$keychain" -P p -T /usr/bin/codesign >/dev/null
		security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(cat "$SIGNING/password")" "$keychain" >/dev/null
	fi
	security unlock-keychain -p "$(cat "$SIGNING/password")" "$keychain"
	codesign --force --sign "$IDENTITY" --keychain "$keychain" "$1" 2>/dev/null
	security lock-keychain "$keychain"
}

stop
if [ "$os" = darwin ]; then
	contents="$APP/Contents"
	rm -rf "$APP.new"
	mkdir -p "$APP.new/Contents/MacOS" "$APP.new/Contents/Resources"
	mv "$tmp/pi-mobile" "$APP.new/Contents/MacOS/pi-mobile"
	fetch pi-mobile.icns "$APP.new/Contents/Resources/pi-mobile.icns" "${PI_MOBILE_ICON_URL:-}" || rm -f "$APP.new/Contents/Resources/pi-mobile.icns"
	cat > "$APP.new/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>$LABEL</string>
	<key>CFBundleName</key><string>pi-mobile</string>
	<key>CFBundleDisplayName</key><string>pi-mobile</string>
	<key>CFBundleExecutable</key><string>pi-mobile</string>
	<key>CFBundleIconFile</key><string>pi-mobile</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$version</string>
	<key>CFBundleVersion</key><string>$version</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSUIElement</key><true/>
	<key>NSAppleEventsUsageDescription</key><string>讓手機上的 pi 像你一樣操作這台電腦上的 app。</string>
	<key>NSDesktopFolderUsageDescription</key><string>讓手機上的 pi 讀寫桌面上的檔案。</string>
	<key>NSDocumentsFolderUsageDescription</key><string>讓手機上的 pi 讀寫文件裡的檔案。</string>
	<key>NSDownloadsFolderUsageDescription</key><string>讓手機上的 pi 讀寫下載項目裡的檔案。</string>
</dict>
</plist>
EOF
	sign "$APP.new"
	rm -rf "$APP"
	mv "$APP.new" "$APP"
	mkdir -p "$DIR/bin"
	ln -sf "$contents/MacOS/pi-mobile" "$BIN"
	step "簽章，裝到 ~/Applications/pi-mobile.app"

	plist="$HOME/Library/LaunchAgents/$LABEL.plist"
	mkdir -p "$HOME/Library/LaunchAgents"
	cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>AssociatedBundleIdentifiers</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$contents/MacOS/pi-mobile</string><string>serve</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$DIR/pi-mobile.log</string>
	<key>StandardErrorPath</key><string>$DIR/pi-mobile.log</string>
</dict>
</plist>
EOF
	launchctl bootstrap "gui/$(id -u)" "$plist"
else
	mkdir -p "$DIR/bin"
	mv "$tmp/pi-mobile" "$BIN"
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

"$BIN" status >/dev/null 2>&1 || fail "pi-mobile 裝好了，但沒有回應。看狀態：$BIN status，紀錄：tail $DIR/pi-mobile.log"
step "啟動，只聽 Tailscale"

state() { "$BIN" status 2>/dev/null | sed -n "s/^Permission $1: \\([a-z]*\\).*/\\1/p"; }
name() {
	case "$1" in
		desktop) echo "桌面" ;; documents) echo "文件" ;; downloads) echo "下載項目" ;;
		automation) echo "控制 System Events" ;; accessibility) echo "輔助使用" ;; screen) echo "錄製螢幕" ;;
	esac
}
pane() {
	case "$1" in
		desktop | documents | downloads) echo "檔案與檔案夾" ;; automation) echo "自動化" ;;
		accessibility) echo "輔助使用" ;; screen) echo "螢幕與系統錄音" ;;
	esac
}
settings() {
	case "$1" in
		accessibility) open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true ;;
		screen) open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" 2>/dev/null || true ;;
	esac
}
permissions() {
	say ""
	say "允許權限：Mac 會一個一個問，都按「允許」"
	missing=""
	for key in desktop documents downloads automation accessibility screen; do
		waited=0
		shown=""
		while [ "$(state "$key")" = waiting ] || [ -z "$(state "$key")" ]; do
			if [ -z "$shown" ] && [ "$waited" -ge 3 ]; then
				case "$key" in
					accessibility) printf '  … 輔助使用：在跳出的設定裡把 pi-mobile 打開\r' ;;
					*) printf '  … %s\r' "$(name "$key")" ;;
				esac
				shown=1
			fi
			[ "$key" = accessibility ] && [ "$waited" -eq 20 ] && settings accessibility
			[ "$waited" -ge 200 ] && break
			sleep 1
			waited=$((waited + 1))
		done
		if [ "$(state "$key")" = granted ]; then
			printf '\033[2K'
			step "$(name "$key")"
		else
			missing="$missing $key"
		fi
	done
	case "$missing" in
		*screen*)
			if [ -r /dev/tty ]; then
				settings screen
				printf '\033[2K  … 錄製螢幕：在打開的設定裡把 pi-mobile 打開，回到這裡按 Enter'
				read -r _ < /dev/tty || true
				launchctl kickstart -k "gui/$(id -u)/$LABEL"
				waited=0
				while [ "$(state screen)" != granted ] && [ "$(state screen)" != denied ] && [ "$waited" -lt 30 ]; do
					sleep 1
					waited=$((waited + 1))
				done
				printf '\033[2K\r'
				if [ "$(state screen)" = granted ]; then
					step "錄製螢幕"
					missing=$(echo "$missing" | sed 's/ screen//')
				fi
			fi
			;;
	esac
	for key in $missing; do
		say "  ✗ $(name "$key")：還沒允許，Bot 用到時會失敗。到 系統設定 › 隱私權與安全性 › $(pane "$key") 打開 pi-mobile，再執行一次這個安裝指令"
	done
}
[ "$os" = darwin ] && permissions

say ""
"$BIN" status | sed -n 's/^On the phone, add: /好了。在手機的 pi › 設定 › 電腦 輸入：/p'
"$BIN" pair | sed -n 's/^Pairing code: \([0-9]*\) (for \([0-9]*\) minutes)$/配對碼：\1（\2 分鐘內有效；過期了在這台電腦執行 pi-mobile pair 拿新的）/p'
say "手機要登入同一個 Tailscale 帳號。"
