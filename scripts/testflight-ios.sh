#!/bin/sh
set -e
cd "$(dirname "$0")/.."
: "${TEAM:?set TEAM to the Apple developer team id}"
VERSION=$(node -p 'require("./package.json").version')
BUILD=$(date +%Y%m%d%H%M)
npx tsc --noEmit
npx vite build --logLevel error
npx cap sync ios > /dev/null
mkdir -p ios/App/build
cat > ios/App/build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>upload</string>
<key>signingStyle</key><string>automatic</string>
<key>testFlightInternalTestingOnly</key><true/>
</dict></plist>
PLIST
cd ios/App
rm -rf build/pi.xcarchive build/export
xcodebuild archive -project App.xcodeproj -scheme App -configuration Release -destination generic/platform=iOS \
	-archivePath build/pi.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
	MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" -quiet
xcodebuild -exportArchive -archivePath build/pi.xcarchive -exportOptionsPlist build/ExportOptions.plist \
	-exportPath build/export -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM"
echo "uploaded pi mobile $VERSION ($BUILD) to TestFlight"
