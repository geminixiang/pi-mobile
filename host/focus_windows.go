package main

import (
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32         = windows.NewLazySystemDLL("ole32.dll")
	oleaut32      = windows.NewLazySystemDLL("oleaut32.dll")
	coInitialize  = ole32.NewProc("CoInitializeEx")
	coCreate      = ole32.NewProc("CoCreateInstance")
	sysStringLen  = oleaut32.NewProc("SysStringLen")
	sysFreeString = oleaut32.NewProc("SysFreeString")

	clsidAutomation8 = windows.GUID{Data1: 0xe22ad333, Data2: 0xb25f, Data3: 0x460c, Data4: [8]byte{0x83, 0xd0, 0x05, 0x81, 0x10, 0x73, 0x95, 0xc9}}
	iidAutomation    = windows.GUID{Data1: 0x30cbe57d, Data2: 0xd9d0, Data3: 0x452a, Data4: [8]byte{0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee}}
	iidValuePattern  = windows.GUID{Data1: 0xa94cd8b1, Data2: 0x0844, Data3: 0x4cd6, Data4: [8]byte{0x9d, 0x2d, 0x64, 0x05, 0x37, 0xab, 0x39, 0xe9}}
	iidTextPattern   = windows.GUID{Data1: 0x32eba289, Data2: 0x3583, Data3: 0x42c9, Data4: [8]byte{0x9c, 0x59, 0x3b, 0x6d, 0x9a, 0x1e, 0x9b, 0x6a}}
)

const (
	clsctxInproc     = 1
	valuePatternID   = 10002
	textPatternID    = 10014
	caretReadLimit   = 2000
	automationFocus  = 8
	elementPatternAs = 14
	elementType      = 21
	elementTypeName  = 22
	elementPassword  = 35
	valueGet         = 4
	valueReadOnly    = 5
	textSelection    = 5
	textDocument     = 7
	arrayLength      = 3
	arrayItem        = 4
	rangeClone       = 3
	rangeText        = 12
	rangeMoveByUnit  = 14
	rangeMoveToRange = 15
	endpointStart    = 0
	endpointEnd      = 1
	unitCharacter    = 0
)

var controlTypes = map[int32]string{
	50000: "button", 50002: "check box", 50003: "combo box", 50004: "edit", 50005: "link", 50007: "list item", 50008: "list",
	50011: "menu item", 50013: "radio button", 50018: "tab", 50019: "tab item", 50020: "text", 50023: "tree", 50024: "tree item",
	50026: "group", 50028: "data grid", 50029: "data item", 50030: "document", 50032: "window", 50033: "pane", 50036: "table",
	50001: "calendar", 50006: "image", 50009: "menu", 50010: "menu bar", 50012: "progress bar", 50014: "scroll bar", 50015: "slider",
	50016: "spinner", 50017: "status bar", 50021: "tool bar", 50022: "tooltip", 50025: "custom", 50027: "thumb", 50031: "split button",
	50034: "header", 50035: "header item", 50037: "title bar", 50038: "separator", 50039: "semantic zoom", 50040: "app bar",
}

// why: COM objects belong to the thread that made them, and Go moves goroutines between threads, so one locked thread asks UI Automation for everyone
type automation struct {
	asks chan func(client uintptr)
}

func startAutomation() *automation {
	a := &automation{asks: make(chan func(client uintptr))}
	ready := make(chan uintptr)
	go func() {
		runtime.LockOSThread()
		coInitialize.Call(0, 0)
		var client uintptr
		if hr, _, _ := coCreate.Call(uintptr(unsafe.Pointer(&clsidAutomation8)), 0, clsctxInproc, uintptr(unsafe.Pointer(&iidAutomation)), uintptr(unsafe.Pointer(&client))); hr != 0 {
			client = 0
		}
		ready <- client
		for ask := range a.asks {
			ask(client)
		}
	}()
	if <-ready == 0 {
		return nil
	}
	return a
}

func (s *winScreen) focused() (focus, bool) {
	if s.automation == nil {
		return focus{}, false
	}
	var f focus
	var ok bool
	s.automation.ask(func(client uintptr) { f, ok = readFocus(client) })
	f.window = windowTitle(uintptr(windows.GetForegroundWindow()))
	return f, ok
}

func (a *automation) ask(job func(client uintptr)) {
	done := make(chan struct{})
	a.asks <- func(client uintptr) {
		job(client)
		close(done)
	}
	<-done
}

func readFocus(client uintptr) (focus, bool) {
	var element uintptr
	if comCall(client, automationFocus, uintptr(unsafe.Pointer(&element))) != 0 || element == 0 {
		return focus{}, false
	}
	defer release(element)
	var kind, password int32
	comCall(element, elementType, uintptr(unsafe.Pointer(&kind)))
	comCall(element, elementPassword, uintptr(unsafe.Pointer(&password)))
	f := focus{role: controlTypes[kind], caret: -1}
	if f.role == "" {
		var name uintptr
		comCall(element, elementTypeName, uintptr(unsafe.Pointer(&name)))
		f.role = takeString(name)
	}
	if password != 0 {
		f.secret, f.editable = true, true
		return f, true
	}
	if text := pattern(element, textPatternID, &iidTextPattern); text != 0 {
		defer release(text)
		f.editable = kind == 50004 || kind == 50030
		readText(text, &f)
	}
	if value := pattern(element, valuePatternID, &iidValuePattern); value != 0 {
		defer release(value)
		var readOnly int32
		comCall(value, valueReadOnly, uintptr(unsafe.Pointer(&readOnly)))
		f.editable = f.editable || readOnly == 0
		if f.length == 0 {
			var current uintptr
			comCall(value, valueGet, uintptr(unsafe.Pointer(&current)))
			runes := []rune(takeString(current))
			f.length, f.end = len(runes), string(runes[max(len(runes)-focusRead, 0):])
		}
	}
	return f, true
}

func readText(text uintptr, f *focus) {
	var document uintptr
	if comCall(text, textDocument, uintptr(unsafe.Pointer(&document))) != 0 || document == 0 {
		return
	}
	defer release(document)
	tail := clone(document)
	defer release(tail)
	var moved int32
	comCall(tail, rangeMoveToRange, endpointStart, document, endpointEnd)
	comCall(tail, rangeMoveByUnit, endpointStart, unitCharacter, uintptr(^uint32(focusRead)), uintptr(unsafe.Pointer(&moved)))
	end := []rune(rangeString(tail, focusRead+1))
	f.length, f.end = len(end), string(end[max(len(end)-focusRead, 0):])
	var selections uintptr
	if comCall(text, textSelection, uintptr(unsafe.Pointer(&selections))) != 0 || selections == 0 {
		return
	}
	defer release(selections)
	var count int32
	comCall(selections, arrayLength, uintptr(unsafe.Pointer(&count)))
	if count == 0 {
		return
	}
	var selection uintptr
	comCall(selections, arrayItem, 0, uintptr(unsafe.Pointer(&selection)))
	if selection == 0 {
		return
	}
	defer release(selection)
	picked := []rune(rangeString(selection, focusTail+1))
	f.selected = string(picked[:min(len(picked), focusTail)])
	after := clone(document)
	defer release(after)
	comCall(after, rangeMoveToRange, endpointStart, selection, endpointEnd)
	if rest := len([]rune(rangeString(after, caretReadLimit))); rest < caretReadLimit {
		f.caret = rest
	}
}

func pattern(element uintptr, id uintptr, iid *windows.GUID) uintptr {
	var found uintptr
	if comCall(element, elementPatternAs, id, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&found))) != 0 {
		return 0
	}
	return found
}

func clone(textRange uintptr) uintptr {
	var copied uintptr
	comCall(textRange, rangeClone, uintptr(unsafe.Pointer(&copied)))
	return copied
}

func rangeString(textRange uintptr, limit int) string {
	var text uintptr
	comCall(textRange, rangeText, uintptr(limit), uintptr(unsafe.Pointer(&text)))
	return takeString(text)
}

func takeString(text uintptr) string {
	if text == 0 {
		return ""
	}
	defer sysFreeString.Call(text)
	n, _, _ := sysStringLen.Call(text)
	return windows.UTF16ToString(unsafe.Slice((*uint16)(asPointer(text)), n))
}

func comCall(object uintptr, method int, args ...uintptr) uintptr {
	table := *(*unsafe.Pointer)(asPointer(object))
	fn := *(*uintptr)(unsafe.Add(table, uintptr(method)*unsafe.Sizeof(uintptr(0))))
	hr, _, _ := syscall.SyscallN(fn, append([]uintptr{object}, args...)...)
	return hr
}

// why: COM hands back interface pointers as plain words; reading them through a pointer to the word keeps go vet's uintptr rule
func asPointer(address uintptr) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&address))
}

func release(object uintptr) {
	if object != 0 {
		comCall(object, 2)
	}
}
