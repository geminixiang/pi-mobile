package main

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	axPointType = 1
	axSizeType  = 2
	uiTimeout   = 0.5
)

var uiAttributes = []string{"AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPosition", "AXSize", "AXEnabled", "AXFocused", "AXSelected", "AXChildren", "AXVisibleRows"}

const (
	attrRole = iota
	attrSubrole
	attrTitle
	attrDescription
	attrValue
	attrPosition
	attrSize
	attrEnabled
	attrFocused
	attrSelected
	attrChildren
	attrVisibleRows
)

var flattened = map[string]bool{
	"AXGroup": true, "AXScrollArea": true, "AXSplitGroup": true, "AXLayoutArea": true, "AXLayoutItem": true,
	"AXUnknown": true, "AXBrowser": true, "AXCell": true,
}

var skipped = map[string]bool{"AXImage": true, "AXScrollBar": true, "AXColumn": true, "AXSplitter": true, "AXGrowArea": true, "AXValueIndicator": true}

type axTree struct {
	copyMultiple func(uintptr, uintptr, uint32, *uintptr) int32
	arrayCreate  func(uintptr, *uintptr, int64, uintptr) uintptr
	callbacks    uintptr
	booleanType  uint64
	boolean      func(uintptr) bool
	arrayType    uint64
	valueType    uint64
	valueKind    func(uintptr) uint32
	value        func(uintptr, uint32, unsafe.Pointer) bool
	numberType   uint64
	timeout      func(uintptr, float32) int32
	perform      func(uintptr, uintptr) int32
	set          func(uintptr, uintptr, uintptr) int32
	yes          uintptr
	names        uintptr
}

func newAXTree(lib uintptr, s *macScreen) *axTree {
	foundation, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil
	}
	callbacks, err := purego.Dlsym(foundation, "kCFTypeArrayCallBacks")
	if err != nil {
		return nil
	}
	yes, err := purego.Dlsym(foundation, "kCFBooleanTrue")
	if err != nil {
		return nil
	}
	// why: kCFBooleanTrue is a data symbol, so Dlsym gives the address of the pointer, not the CFBoolean
	t := &axTree{callbacks: callbacks, yes: *(*uintptr)(unsafe.Add(nil, yes))}
	var booleanType, arrayType, valueType, numberType func() uint64
	for symbol, fn := range map[string]any{
		"AXUIElementCopyMultipleAttributeValues": &t.copyMultiple, "AXValueGetType": &t.valueKind, "AXValueGetValue": &t.value,
		"AXValueGetTypeID": &valueType, "AXUIElementSetMessagingTimeout": &t.timeout,
		"AXUIElementPerformAction": &t.perform, "AXUIElementSetAttributeValue": &t.set,
	} {
		purego.RegisterLibFunc(fn, lib, symbol)
	}
	for symbol, fn := range map[string]any{
		"CFArrayCreate": &t.arrayCreate, "CFBooleanGetTypeID": &booleanType, "CFBooleanGetValue": &t.boolean,
		"CFArrayGetTypeID": &arrayType, "CFNumberGetTypeID": &numberType,
	} {
		purego.RegisterLibFunc(fn, foundation, symbol)
	}
	t.booleanType, t.arrayType, t.valueType, t.numberType = booleanType(), arrayType(), valueType(), numberType()
	keys := make([]uintptr, len(uiAttributes))
	for i, name := range uiAttributes {
		keys[i] = s.stringCreate(0, name, cfUTF8)
	}
	t.names = t.arrayCreate(0, &keys[0], int64(len(keys)), callbacks)
	for _, key := range keys {
		s.release(key)
	}
	return t
}

func (s *macScreen) window() ([]uiNode, bool) {
	if s.tree == nil {
		return nil, false
	}
	pid := s.frontWindowPID()
	if pid == 0 || !s.axTrusted() {
		return nil, false
	}
	app := s.appElement(pid)
	defer s.release(app)
	s.tree.timeout(app, uiTimeout)
	window := s.attribute(app, "AXFocusedWindow")
	if window == 0 {
		return nil, false
	}
	defer s.release(window)
	walk := &uiWalker{s: s}
	walk.visit(window, 0)
	return append(walk.nodes, s.otherWindows(pid)...), walk.seen > 1
}

func (s *macScreen) otherWindows(front int32) []uiNode {
	listed := s.ax.windowList(onScreenOnly|excludeDesktop, 0)
	if listed == 0 {
		return nil
	}
	defer s.release(listed)
	seen := map[int32]bool{front: true}
	var nodes []uiNode
	for i := range s.ax.count(listed) {
		window := s.ax.item(listed, i)
		layer, owner := s.ax.lookup(window, s.ax.layerKey), s.ax.lookup(window, s.ax.pidKey)
		var depth, pid int32
		if layer == 0 || owner == 0 || !s.ax.number(layer, cfNumberSInt32, unsafe.Pointer(&depth)) || depth != 0 || !s.ax.number(owner, cfNumberSInt32, unsafe.Pointer(&pid)) || seen[pid] {
			continue
		}
		seen[pid] = true
		nodes = append(nodes, s.appWindows(pid)...)
		if len(nodes) >= uiOthers {
			return nodes[:uiOthers]
		}
	}
	return nodes
}

func (s *macScreen) appWindows(pid int32) []uiNode {
	app := s.appElement(pid)
	defer s.release(app)
	s.tree.timeout(app, uiTimeout)
	name := s.text(s.attribute(app, "AXTitle"))
	windows := s.attribute(app, "AXWindows")
	if windows == 0 {
		return nil
	}
	defer s.release(windows)
	var nodes []uiNode
	for i := range s.ax.count(windows) {
		window := s.ax.item(windows, i)
		minimized := s.attribute(window, "AXMinimized")
		if minimized != 0 {
			s.release(minimized)
		}
		if minimized == s.tree.yes {
			continue
		}
		title := s.text(s.attribute(window, "AXTitle"))
		if title == "" {
			continue
		}
		nodes = append(nodes, uiNode{role: "window", name: strings.TrimSpace(title + " (" + name + ", behind)"), target: macRaise{s: s, pid: pid, title: title}})
	}
	return nodes
}

type macRaise struct {
	s     *macScreen
	pid   int32
	title string
}

func (r macRaise) selects() bool { return false }

func (r macRaise) activate(bool) error {
	s := r.s
	app := s.appElement(r.pid)
	defer s.release(app)
	windows := s.attribute(app, "AXWindows")
	if windows == 0 {
		return errors.New("the app has no windows now")
	}
	defer s.release(windows)
	for i := range s.ax.count(windows) {
		window := s.ax.item(windows, i)
		if s.text(s.attribute(window, "AXTitle")) != r.title {
			continue
		}
		raise, frontmost := s.stringCreate(0, "AXRaise", cfUTF8), s.stringCreate(0, "AXFrontmost", cfUTF8)
		defer s.release(raise)
		defer s.release(frontmost)
		s.tree.perform(window, raise)
		if s.tree.set(app, frontmost, s.tree.yes) != 0 {
			return errors.New("macOS did not bring the app to the front")
		}
		return nil
	}
	return fmt.Errorf("no window %q now", r.title)
}

type uiWalker struct {
	s     *macScreen
	nodes []uiNode
	seen  int
}

func (w *uiWalker) visit(element uintptr, depth int) {
	if w.seen >= uiWalk || depth > uiDepth {
		return
	}
	w.seen++
	t, s := w.s.tree, w.s
	var values uintptr
	if t.copyMultiple(element, t.names, 0, &values) != 0 || values == 0 {
		return
	}
	defer s.release(values)
	at := func(i int) uintptr { return s.ax.item(values, int64(i)) }
	role := w.str(at(attrRole))
	if skipped[role] {
		return
	}
	subrole := w.str(at(attrSubrole))
	n := uiNode{depth: depth, role: roleName(role, subrole), name: firstOf(w.str(at(attrTitle)), w.str(at(attrDescription)))}
	switch value := w.str(at(attrValue)); {
	case value == "" || value == n.name:
	case role == "AXStaticText" && n.name == "":
		n.name = value
	default:
		n.name = strings.TrimSpace(n.name + " =" + value)
	}
	if n.name == "" && role == "AXButton" {
		n.name = strings.TrimSuffix(strings.TrimPrefix(subrole, "AX"), "Button")
	}
	var pos cgPoint
	var size struct{ W, H float64 }
	if w.axValue(at(attrPosition), axPointType, unsafe.Pointer(&pos)) && w.axValue(at(attrSize), axSizeType, unsafe.Pointer(&size)) {
		if size.W <= 1 || size.H <= 1 {
			return
		}
		n.x, n.y, n.placed = pos.X+size.W/2, pos.Y+size.H/2, true
	}
	enabled, known := w.boolean(at(attrEnabled))
	n.disabled = known && !enabled
	n.focused, _ = w.boolean(at(attrFocused))
	n.selected, _ = w.boolean(at(attrSelected))
	if role == "AXCheckBox" || role == "AXRadioButton" {
		n.checked = w.number(at(attrValue)) == 1
	}
	children := at(attrVisibleRows)
	if w.kind(children) != t.arrayType {
		children = at(attrChildren)
	}
	if role == "AXRow" && n.name == "" {
		n.name = strings.Join(w.texts(children, 0), " | ")
		w.nodes = append(w.nodes, n)
		return
	}
	next := depth + 1
	if flattened[role] && n.name == "" {
		next = depth
	} else {
		w.nodes = append(w.nodes, n)
	}
	if w.kind(children) != t.arrayType {
		return
	}
	for i := range s.ax.count(children) {
		w.visit(s.ax.item(children, i), next)
	}
}

func (w *uiWalker) texts(children uintptr, depth int) []string {
	s, t := w.s, w.s.tree
	if depth > 4 || w.kind(children) != t.arrayType {
		return nil
	}
	var found []string
	for i := range s.ax.count(children) {
		var values uintptr
		if t.copyMultiple(s.ax.item(children, i), t.names, 0, &values) != 0 || values == 0 {
			continue
		}
		at := func(i int) uintptr { return s.ax.item(values, int64(i)) }
		if text := firstOf(w.str(at(attrValue)), w.str(at(attrTitle))); text != "" {
			found = append(found, text)
		}
		found = append(found, w.texts(at(attrChildren), depth+1)...)
		s.release(values)
	}
	return found
}

func (w *uiWalker) kind(value uintptr) uint64 {
	if value == 0 {
		return 0
	}
	return w.s.ax.typeOf(value)
}

func (w *uiWalker) str(value uintptr) string {
	if w.kind(value) != w.s.ax.stringType {
		return ""
	}
	length := w.s.ax.length(value)
	keep := min(length, uiName+1)
	units := make([]uint16, keep)
	if keep > 0 {
		w.s.ax.characters(value, cfRange{0, keep}, &units[0])
	}
	return strings.TrimSpace(string(utf16.Decode(units)))
}

func (w *uiWalker) boolean(value uintptr) (on, known bool) {
	if w.kind(value) != w.s.tree.booleanType {
		return false, false
	}
	return w.s.tree.boolean(value), true
}

func (w *uiWalker) number(value uintptr) int32 {
	var n int32
	if w.kind(value) != w.s.tree.numberType || !w.s.ax.number(value, cfNumberSInt32, unsafe.Pointer(&n)) {
		return -1
	}
	return n
}

func (w *uiWalker) axValue(value uintptr, kind uint32, out unsafe.Pointer) bool {
	return w.kind(value) == w.s.tree.valueType && w.s.tree.valueKind(value) == kind && w.s.tree.value(value, kind, out)
}

func roleName(role, subrole string) string {
	switch role {
	case "AXStaticText":
		return "text"
	case "AXTextField":
		if subrole == "AXSearchField" {
			return "searchfield"
		}
		return "textfield"
	}
	return strings.ToLower(strings.TrimPrefix(role, "AX"))
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
