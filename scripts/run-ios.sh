#!/bin/sh
set -e
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
DEVICE="${1:-iPhone 18 Pro}"
npx tsc --noEmit
npx vite build --logLevel error
PI_MOBILE_DEBUG=1 npx cap sync ios > /dev/null
# why: an unsigned build has no keychain entitlement, so saving a key fails with -34018; ad hoc signing needs no account
(cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
	-destination 'generic/platform=iOS Simulator' -derivedDataPath build/sim \
	CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= -quiet build)
xcrun simctl boot "$DEVICE" 2> /dev/null || true
xcrun simctl bootstatus "$DEVICE" -b > /dev/null
xcrun simctl install "$DEVICE" ios/App/build/sim/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch --terminate-running-process "$DEVICE" dev.geminixiang.pimobile > /dev/null
if ! pgrep -q ios_webkit_debug_proxy; then
	SOCKET=$(lsof -aUc launchd_sim 2> /dev/null | awk '/webinspectord_sim/ { print $NF; exit }')
	ios_webkit_debug_proxy -s "unix:$SOCKET" > /dev/null 2>&1 &
fi
echo "pi mobile on $DEVICE; WEBKIT=1 ./test/ui.sh '<async fn>' drives it"
