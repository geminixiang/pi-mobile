package computer

import (
	"image"
	"image/color"
	"reflect"
	"testing"

	"github.com/jezek/xgb/xproto"
)

func TestDesktopEnvironmentTakesTheSessionFromSystemd(t *testing.T) {
	systemd := []byte("HOME=/home/me\nDISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nXAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.Q1\nXDG_CURRENT_DESKTOP=$'GNOME\\x1f'\nDBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\n")
	want := map[string]string{"DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-0", "XAUTHORITY": "/run/user/1000/.mutter-Xwaylandauth.Q1", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"}
	if got := desktopEnvironment(systemd); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestKeysymsNameTheKeysTheCoreAsksFor(t *testing.T) {
	for name, want := range map[string]uint32{"ctrl": 0xffe3, "cmd": 0xffeb, "return": 0xff0d, "f4": 0xffc1, "t": 't'} {
		if got, ok := keysymOf(name); !ok || got != want {
			t.Errorf("%q = %#x %v, want %#x", name, got, ok, want)
		}
	}
}

func TestRuneKeysymCoversLatin1AndUnicode(t *testing.T) {
	for r, want := range map[rune]uint32{'a': 'a', 'Z': 'Z', 'é': 0xe9, '中': 0x01004e2d, '☃': 0x01002603, '\t': 0xff09} {
		if got := runeKeysym(r); got != want {
			t.Errorf("%q = %#x, want %#x", r, got, want)
		}
	}
}

func TestZpixmapReadsPaddedBGRX(t *testing.T) {
	setup := &xproto.SetupInfo{ImageByteOrder: xproto.ImageOrderLSBFirst, PixmapFormats: []xproto.Format{{Depth: 24, BitsPerPixel: 32, ScanlinePad: 32}}}
	data := []byte{0x30, 0x20, 0x10, 0, 0x03, 0x02, 0x01, 0, 0xff, 0x00, 0x00, 0, 0x00, 0xff, 0x00, 0}
	img, err := zpixmap(data, 24, 2, 2, setup)
	if err != nil {
		t.Fatal(err)
	}
	for at, want := range map[image.Point]color.RGBA{{0, 0}: {0x10, 0x20, 0x30, 0xff}, {1, 0}: {1, 2, 3, 0xff}, {0, 1}: {0, 0, 0xff, 0xff}, {1, 1}: {0, 0xff, 0, 0xff}} {
		if got := img.RGBAAt(at.X, at.Y); got != want {
			t.Errorf("pixel %v = %v, want %v", at, got, want)
		}
	}
	if _, err := zpixmap(data, 16, 2, 2, &xproto.SetupInfo{PixmapFormats: []xproto.Format{{Depth: 16, BitsPerPixel: 16, ScanlinePad: 32}}}); err == nil {
		t.Error("a 16-bit display was read as if it were 32-bit")
	}
}

func TestCropToStreamKeepsOnlyTheSharedMonitor(t *testing.T) {
	single := image.NewRGBA(image.Rect(0, 0, 2880, 1800))
	if got := cropToStream(single, streamArea{width: 1440, height: 900}).Bounds(); got != single.Bounds() {
		t.Errorf("one scaled monitor cropped to %v", got)
	}
	both := image.NewRGBA(image.Rect(0, 0, 3840, 1080))
	if got := cropToStream(both, streamArea{x: 1920, width: 1920, height: 1080}).Bounds(); got != image.Rect(1920, 0, 3840, 1080) {
		t.Errorf("right monitor cropped to %v", got)
	}
}
