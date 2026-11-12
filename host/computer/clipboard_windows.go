package computer

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	globalAlloc             = kernel32.NewProc("GlobalAlloc")
	globalFree              = kernel32.NewProc("GlobalFree")
	globalLock              = kernel32.NewProc("GlobalLock")
	globalUnlock            = kernel32.NewProc("GlobalUnlock")
	globalSize              = kernel32.NewProc("GlobalSize")
	openClipboard           = user32.NewProc("OpenClipboard")
	closeClipboard          = user32.NewProc("CloseClipboard")
	emptyClipboard          = user32.NewProc("EmptyClipboard")
	enumClipboardFormats    = user32.NewProc("EnumClipboardFormats")
	getClipboardData        = user32.NewProc("GetClipboardData")
	setClipboardData        = user32.NewProc("SetClipboardData")
	registerClipboardFormat = user32.NewProc("RegisterClipboardFormatW")
)

const (
	cfUnicodeText = 13
	gmemMoveable  = 0x0002
)

var errClipboardBusy = errors.New("another app holds the clipboard")

var gdiFormats = map[uintptr]bool{2: true, 3: true, 9: true, 14: true, 0x80: true, 0x82: true, 0x83: true, 0x8e: true}

type clipItem struct {
	format uintptr
	data   []byte
}

func withClipboard(use func() error) error {
	for range 20 {
		if opened, _, _ := openClipboard.Call(0); opened != 0 {
			defer closeClipboard.Call()
			return use()
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errClipboardBusy
}

func clipboardItems() []clipItem {
	items := []clipItem{}
	for format, _, _ := enumClipboardFormats.Call(0); format != 0; format, _, _ = enumClipboardFormats.Call(format) {
		if gdiFormats[format] {
			continue
		}
		handle, _, _ := getClipboardData.Call(format)
		if handle == 0 {
			continue
		}
		size, _, _ := globalSize.Call(handle)
		memory, _, _ := globalLock.Call(handle)
		if memory == 0 {
			continue
		}
		items = append(items, clipItem{format, append([]byte(nil), unsafe.Slice((*byte)(unsafe.Add(nil, memory)), size)...)})
		globalUnlock.Call(handle)
	}
	return items
}

func textItem(text string) clipItem {
	units := windows.StringToUTF16(text)
	return clipItem{cfUnicodeText, unsafe.Slice((*byte)(unsafe.Pointer(&units[0])), len(units)*2)}
}

func writeClipboard(items []clipItem) error {
	emptyClipboard.Call()
	name, _ := windows.UTF16PtrFromString("ExcludeClipboardContentFromMonitorProcessing")
	// why: Windows keeps what reaches the clipboard in its history (Win+V) and may sync it; this format keeps the bot's text and the restored clipboard out
	exclude, _, _ := registerClipboardFormat.Call(uintptr(unsafe.Pointer(name)))
	for _, item := range append(items, clipItem{exclude, []byte{0, 0, 0, 0}}) {
		handle, _, err := globalAlloc.Call(gmemMoveable, uintptr(max(len(item.data), 1)))
		if handle == 0 {
			return fmt.Errorf("GlobalAlloc: %w", err)
		}
		memory, _, _ := globalLock.Call(handle)
		copy(unsafe.Slice((*byte)(unsafe.Add(nil, memory)), len(item.data)), item.data)
		globalUnlock.Call(handle)
		if set, _, err := setClipboardData.Call(item.format, handle); set == 0 {
			globalFree.Call(handle)
			return fmt.Errorf("SetClipboardData: %w", err)
		}
	}
	return nil
}
