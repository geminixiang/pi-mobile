package main

import (
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	axRangeType    = 4
	onScreenOnly   = 1
	excludeDesktop = 16
	cfNumberSInt32 = 3
)

type cfRange struct{ location, length int64 }

type axFocus struct {
	windowList func(uint32, uint32) uintptr
	count      func(uintptr) int64
	item       func(uintptr, int64) uintptr
	lookup     func(uintptr, uintptr) uintptr
	number     func(uintptr, int32, unsafe.Pointer) bool
	layerKey   uintptr
	pidKey     uintptr
	typeOf     func(uintptr) uint64
	stringType uint64
	length     func(uintptr) int64
	characters func(uintptr, cfRange, *uint16)
	rangeOf    func(uintptr, uint32, *cfRange) bool
	settable   func(uintptr, uintptr, *bool) int32
}

func newAXFocus(lib uintptr, name func(uintptr, string, uint32) uintptr) *axFocus {
	f := &axFocus{}
	var stringTypeID func() uint64
	for symbol, fn := range map[string]any{
		"CGWindowListCopyWindowInfo": &f.windowList, "CFArrayGetCount": &f.count, "CFArrayGetValueAtIndex": &f.item,
		"CFDictionaryGetValue": &f.lookup, "CFNumberGetValue": &f.number,
		"CFGetTypeID": &f.typeOf, "CFStringGetTypeID": &stringTypeID,
		"CFStringGetLength": &f.length, "CFStringGetCharacters": &f.characters, "AXValueGetValue": &f.rangeOf,
		"AXUIElementIsAttributeSettable": &f.settable,
	} {
		purego.RegisterLibFunc(fn, lib, symbol)
	}
	f.stringType = stringTypeID()
	f.layerKey, f.pidKey = name(0, "kCGWindowLayer", cfUTF8), name(0, "kCGWindowOwnerPID", cfUTF8)
	return f
}

func (s *macScreen) frontWindowPID() int32 {
	pids := s.windowPIDs()
	if len(pids) == 0 {
		return 0
	}
	return pids[0]
}

func (s *macScreen) windowPIDs() []int32 {
	windows := s.ax.windowList(onScreenOnly|excludeDesktop, 0)
	if windows == 0 {
		return nil
	}
	defer s.release(windows)
	seen := map[int32]bool{}
	var pids []int32
	for i := range s.ax.count(windows) {
		window := s.ax.item(windows, i)
		layer, owner := s.ax.lookup(window, s.ax.layerKey), s.ax.lookup(window, s.ax.pidKey)
		var depth, pid int32
		if layer == 0 || owner == 0 || !s.ax.number(layer, cfNumberSInt32, unsafe.Pointer(&depth)) || depth != 0 || !s.ax.number(owner, cfNumberSInt32, unsafe.Pointer(&pid)) || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}

func (s *macScreen) focused() (focus, bool) {
	pid := s.frontWindowPID()
	if pid == 0 || !s.axTrusted() {
		return focus{}, false
	}
	// why: the system-wide element answers AXFocusedUIElement with -25204 (cannot complete) in this process, while the app's own element answers
	app := s.appElement(pid)
	defer s.release(app)
	element := s.attribute(app, "AXFocusedUIElement")
	if element == 0 {
		return focus{}, false
	}
	defer s.release(element)
	f := focus{role: s.text(s.attribute(element, "AXRole")), caret: -1}
	if window := s.attribute(element, "AXWindow"); window != 0 {
		f.window = s.text(s.attribute(window, "AXTitle"))
		s.release(window)
	}
	if s.text(s.attribute(element, "AXSubrole")) == "AXSecureTextField" {
		f.secret, f.editable = true, true
		return f, true
	}
	key := s.stringCreate(0, "AXValue", cfUTF8)
	var settable bool
	f.editable = s.ax.settable(element, key, &settable) == 0 && settable
	s.release(key)
	value := s.attribute(element, "AXValue")
	if value == 0 {
		return f, true
	}
	defer s.release(value)
	if s.ax.typeOf(value) != s.ax.stringType {
		return f, true
	}
	f.length = int(s.ax.length(value))
	f.end = s.tail(value, int64(f.length), focusRead)
	if selected := s.attribute(element, "AXSelectedText"); selected != 0 {
		if s.ax.typeOf(selected) == s.ax.stringType {
			f.selected = s.tail(selected, s.ax.length(selected), focusTail)
		}
		s.release(selected)
	}
	if picked := s.attribute(element, "AXSelectedTextRange"); picked != 0 {
		var at cfRange
		if s.ax.rangeOf(picked, axRangeType, &at) {
			f.caret = f.length - int(at.location+at.length)
		}
		s.release(picked)
	}
	return f, true
}

func (s *macScreen) tail(text uintptr, length int64, keep int) string {
	from := max(length-int64(keep)*2, 0)
	units := make([]uint16, length-from)
	if len(units) > 0 {
		s.ax.characters(text, cfRange{from, length - from}, &units[0])
	}
	runes := utf16.Decode(units)
	return string(runes[max(len(runes)-keep, 0):])
}
