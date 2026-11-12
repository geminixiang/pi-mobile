package computer

import (
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	keyActionDisplay = 3
	shiftState       = 2
	noDeadKeys       = 1
)

type keyboardLayout struct {
	source    func() uintptr
	property  func(uintptr, uintptr) uintptr
	bytes     func(uintptr) uintptr
	kind      func() uint8
	translate func(uintptr, uint16, uint16, uint32, uint32, uint32, *uint32, uint64, *uint64, *uint16) int32
	release   func(uintptr)
	layoutKey uintptr
}

func newKeyboardLayout(release func(uintptr)) (*keyboardLayout, error) {
	lib, err := purego.Dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	key, err := purego.Dlsym(lib, "kTISPropertyUnicodeKeyLayoutData")
	if err != nil {
		return nil, err
	}
	k := &keyboardLayout{release: release, layoutKey: **(**uintptr)(unsafe.Pointer(&key))}
	for name, fn := range map[string]any{
		"TISCopyCurrentASCIICapableKeyboardLayoutInputSource": &k.source, "TISGetInputSourceProperty": &k.property,
		"CFDataGetBytePtr": &k.bytes, "LMGetKbdType": &k.kind, "UCKeyTranslate": &k.translate,
	} {
		purego.RegisterLibFunc(fn, lib, name)
	}
	return k, nil
}

func (k *keyboardLayout) find(char string) (code uint16, shift bool, ok bool) {
	source := k.source()
	if source == 0 {
		return 0, false, false
	}
	defer k.release(source)
	data := k.property(source, k.layoutKey)
	if data == 0 {
		return 0, false, false
	}
	layout, kind := k.bytes(data), uint32(k.kind())
	// why: macOS numbers the keypad from 65, and an app reads keypad + or = differently from the main keys
	for _, codes := range [][2]uint16{{0, 65}, {65, 128}} {
		for _, state := range []uint32{0, shiftState} {
			for code := codes[0]; code < codes[1]; code++ {
				var dead uint32
				var length uint64
				out := make([]uint16, 4)
				if k.translate(layout, code, keyActionDisplay, state, kind, noDeadKeys, &dead, uint64(len(out)), &length, &out[0]) == 0 && string(utf16.Decode(out[:length])) == char {
					return code, state == shiftState, true
				}
			}
		}
	}
	return 0, false, false
}
