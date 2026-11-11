package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"slices"
	"strings"

	"github.com/jezek/xgb/xproto"
)

var desktopVariables = []string{"DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS"}

func desktopEnvironment(systemd []byte) map[string]string {
	found := map[string]string{}
	lines := bufio.NewScanner(bytes.NewReader(systemd))
	for lines.Scan() {
		name, value, ok := strings.Cut(lines.Text(), "=")
		if ok && !strings.HasPrefix(value, "$'") && slices.Contains(desktopVariables, name) {
			found[name] = value
		}
	}
	return found
}

var namedKeysyms = map[string]uint32{
	"return": 0xff0d, "tab": 0xff09, "space": 0x20, "backspace": 0xff08, "esc": 0xff1b,
	"forwarddelete": 0xffff, "insert": 0xff63, "home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56,
	"left": 0xff51, "up": 0xff52, "right": 0xff53, "down": 0xff54,
	"f1": 0xffbe, "f2": 0xffbf, "f3": 0xffc0, "f4": 0xffc1, "f5": 0xffc2, "f6": 0xffc3, "f7": 0xffc4, "f8": 0xffc5, "f9": 0xffc6, "f10": 0xffc7, "f11": 0xffc8, "f12": 0xffc9,
}

var modifierKeysyms = map[string]uint32{
	"shift": 0xffe1, "ctrl": 0xffe3, "alt": 0xffe9, "cmd": 0xffeb,
}

func keysymOf(name string) (uint32, bool) {
	if sym, ok := namedKeysyms[name]; ok {
		return sym, true
	}
	if sym, ok := modifierKeysyms[name]; ok {
		return sym, true
	}
	runes := []rune(name)
	if len(runes) != 1 {
		return 0, false
	}
	return runeKeysym(runes[0]), true
}

func runeKeysym(r rune) uint32 {
	switch {
	case r == '\t':
		return 0xff09
	case r >= 0x20 && r <= 0x7e, r >= 0xa0 && r <= 0xff:
		return uint32(r)
	}
	return 0x01000000 | uint32(r)
}

func zpixmap(data []byte, depth byte, width, height int, setup *xproto.SetupInfo) (*image.RGBA, error) {
	bits, pad := 0, 0
	for _, format := range setup.PixmapFormats {
		if format.Depth == depth {
			bits, pad = int(format.BitsPerPixel), int(format.ScanlinePad)
		}
	}
	if bits != 32 || depth < 24 {
		return nil, fmt.Errorf("X11 screenshot: the display is %d-bit (%d bits per pixel); only 24- and 32-bit displays are supported", depth, bits)
	}
	stride := (width*bits + pad - 1) / pad * pad / 8
	if len(data) < stride*height {
		return nil, fmt.Errorf("X11 screenshot: %d bytes for a %dx%d image", len(data), width, height)
	}
	order := binary.ByteOrder(binary.LittleEndian)
	if setup.ImageByteOrder == xproto.ImageOrderMSBFirst {
		order = binary.BigEndian
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for row := range height {
		for col := range width {
			pixel := order.Uint32(data[row*stride+col*4:])
			at := img.PixOffset(col, row)
			img.Pix[at], img.Pix[at+1], img.Pix[at+2], img.Pix[at+3] = byte(pixel>>16), byte(pixel>>8), byte(pixel), 0xff
		}
	}
	return img, nil
}

type streamArea struct {
	x, y, width, height float64
}

func cropToStream(img image.Image, session streamArea) image.Image {
	bounds := img.Bounds()
	imageAspect := float64(bounds.Dx()) / float64(bounds.Dy())
	streamAspect := session.width / session.height
	if session.x == 0 && session.y == 0 && imageAspect > streamAspect*0.99 && imageAspect < streamAspect*1.01 {
		return img
	}
	factor := float64(bounds.Dy()) / session.height
	area := image.Rect(int(session.x*factor), int(session.y*factor), int((session.x+session.width)*factor), int((session.y+session.height)*factor)).Add(bounds.Min).Intersect(bounds)
	cropper, ok := img.(interface {
		SubImage(image.Rectangle) image.Image
	})
	if !ok || area.Empty() {
		return img
	}
	return cropper.SubImage(area)
}
