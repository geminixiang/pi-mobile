#!/bin/sh
set -e
cd "$(dirname "$0")"
IDEVICE_COMMIT=89702099f4d7552f704f93b4526756abda319ceb
if [ ! -d vendor/idevice ]; then
	git clone -q https://github.com/jkcoxson/idevice.git vendor/idevice
	git -C vendor/idevice checkout -q "$IDEVICE_COMMIT"
	git -C vendor/idevice apply ../../idevice-run-over-rsd.patch
fi
[ "$(git -C vendor/idevice rev-parse HEAD)" = "$IDEVICE_COMMIT" ] || { echo "vendor/idevice is not at $IDEVICE_COMMIT: delete vendor/ and rerun"; exit 1; }
rustup target add aarch64-apple-ios > /dev/null
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" IPHONEOS_DEPLOYMENT_TARGET=26.0 cargo build -q --release --target aarch64-apple-ios
