#!/bin/sh
set -e
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
ENV_FILE="${PI_MOBILE_RELEASE_ENV:-$HOME/.config/pi-mobile/release.env}"
[ -f "$ENV_FILE" ] || { echo "No signing settings: $ENV_FILE (TEAM, ASC_KEY_ID, ASC_ISSUER_ID)"; exit 1; }
set -a; . "$ENV_FILE"; set +a
DEVICE="${DEVICE:?set DEVICE to the UDID from xcrun devicectl list devices}"
SIGN="-allowProvisioningUpdates -authenticationKeyPath ${ASC_KEY_PATH:-$(dirname "$ENV_FILE")/AuthKey_$ASC_KEY_ID.p8} -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"
IDEVICE=ios/agentscreen-rs/vendor/idevice

tools() {
	[ -x "$IDEVICE/target/release/idevice-tools" ] || (cd "$IDEVICE" && cargo build -q --release -p idevice-tools)
	echo "$IDEVICE/target/release/idevice-tools"
}

case "${1:-build}" in
(build)
	npx tsc --noEmit
	npx vite build --logLevel error
	PI_MOBILE_DEBUG=1 npx cap sync ios > /dev/null
	mkdir -p ios/OSS/build
	cp ios/App/App/Info.plist ios/OSS/build/Info.plist
	plutil -insert UIBackgroundModes -json '["audio"]' ios/OSS/build/Info.plist
	xcodegen generate --quiet --spec ios/OSS/project.yml
	xcodebuild -project ios/OSS/PiOSS.xcodeproj -scheme App -configuration Debug -destination generic/platform=iOS -derivedDataPath ios/OSS/build/dd DEVELOPMENT_TEAM="$TEAM" $SIGN -quiet build
	xcrun devicectl device install app --device "$DEVICE" ios/OSS/build/dd/Build/Products/Debug-iphoneos/App.app > /dev/null
	echo "pi (open source edition) installed on $DEVICE"
	;;
(pair)
	OUT=ios/OSS/build/rp-pairing.plist
	mkdir -p ios/OSS/build
	"$(tools)" --udid "$DEVICE" remotepairing_lockdown pair pi "$OUT"
	xcrun devicectl device copy to --device "$DEVICE" --domain-type appDataContainer --domain-identifier dev.geminixiang.pimobile \
		--source "$OUT" --destination Documents/agent-screen/rp-pairing.plist > /dev/null
	rm "$OUT"
	echo "pairing saved for future developer disk image mounting; screen control does not use it"
	;;
(*)
	echo "usage: DEVICE=<udid> scripts/ios-oss.sh build|pair"
	exit 1
	;;
esac
