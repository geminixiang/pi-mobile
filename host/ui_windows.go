package main

import (
	"errors"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	automationFromHandle  = 6
	automationControlView = 14
	walkerFirstChild      = 4
	walkerNextSibling     = 6
	elementName           = 23
	elementHasFocus       = 26
	elementEnabled        = 28
	elementOffscreen      = 38
	elementBounds         = 43
	selectionItemID       = 10010
	toggleID              = 10015
	selectedGet           = 6
	toggleGet             = 4
	uiBudget              = 1500 * time.Millisecond
	swRestore             = 9
	gwlExStyle            = ^uintptr(19)
	exToolWindow          = 0x80
	exNoActivate          = 0x08000000
	dwmCloaked            = 14
)

var (
	isIconic            = user32.NewProc("IsIconic")
	showWindow          = user32.NewProc("ShowWindow")
	setForegroundWindow = user32.NewProc("SetForegroundWindow")
	bringWindowToTop    = user32.NewProc("BringWindowToTop")
	getWindowRect       = user32.NewProc("GetWindowRect")
	attachThreadInput   = user32.NewProc("AttachThreadInput")
	getWindowLong       = user32.NewProc("GetWindowLongW")
	dwmAttribute        = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmGetWindowAttribute")
	iidSelectionItem    = windows.GUID{Data1: 0xa8efa66a, Data2: 0x0fda, Data3: 0x421a, Data4: [8]byte{0x91, 0x94, 0x38, 0x02, 0x1f, 0x35, 0x78, 0xea}}
	iidToggle           = windows.GUID{Data1: 0x94cf8058, Data2: 0x9b8d, Data3: 0x4ab9, Data4: [8]byte{0x8b, 0xfd, 0x4c, 0xd0, 0xa3, 0x3c, 0x8c, 0x70}}
)

var (
	skippedTypes   = map[int32]bool{50006: true, 50014: true, 50027: true, 50037: true, 50038: true, 50022: true}
	flattenedTypes = map[int32]bool{50033: true, 50025: true, 50026: true, 50039: true}
	leafTypes      = map[int32]bool{50007: true, 50024: true, 50029: true, 50019: true, 50005: true}
)

func (s *winScreen) window(on display) ([]uiNode, bool) {
	if s.automation == nil {
		return nil, false
	}
	front := topOn(on)
	if front == 0 {
		return nil, false
	}
	var nodes []uiNode
	var read bool
	s.automation.ask(func(client uintptr) { nodes, read = walkWindow(client, front) })
	return append(nodes, behind(front)...), read
}

func walkWindow(client, handle uintptr) ([]uiNode, bool) {
	var root, walker uintptr
	if comCall(client, automationFromHandle, handle, uintptr(unsafe.Pointer(&root))) != 0 || root == 0 {
		return nil, false
	}
	defer release(root)
	if comCall(client, automationControlView, uintptr(unsafe.Pointer(&walker))) != 0 || walker == 0 {
		return nil, false
	}
	defer release(walker)
	w := &uiaWalker{walker: walker, deadline: time.Now().Add(uiBudget)}
	w.visit(root, 0)
	return w.nodes, w.seen > 1
}

type uiaWalker struct {
	walker   uintptr
	deadline time.Time
	nodes    []uiNode
	seen     int
}

func (w *uiaWalker) visit(element uintptr, depth int) {
	if w.seen >= uiWalk || depth > uiDepth || time.Now().After(w.deadline) {
		return
	}
	w.seen++
	var kind, offscreen int32
	comCall(element, elementType, uintptr(unsafe.Pointer(&kind)))
	comCall(element, elementOffscreen, uintptr(unsafe.Pointer(&offscreen)))
	if skippedTypes[kind] || (depth > 0 && offscreen != 0) {
		return
	}
	n := uiNode{depth: depth, role: controlTypes[kind], name: elementString(element, elementName)}
	if n.role == "" {
		n.role = elementString(element, elementTypeName)
	}
	if value := pattern(element, valuePatternID, &iidValuePattern); value != 0 {
		var current uintptr
		comCall(value, valueGet, uintptr(unsafe.Pointer(&current)))
		release(value)
		if text := strings.TrimSpace(takeString(current)); text != "" && text != n.name && kind != 50030 {
			n.name = strings.TrimSpace(n.name + " =" + clip(text, uiName))
		}
	}
	if kind == 50030 {
		if text := pattern(element, textPatternID, &iidTextPattern); text != 0 {
			var f focus
			readText(text, &f)
			release(text)
			if f.end != "" {
				n.name = strings.TrimSpace(n.name + " =" + lastLines(f.end, f.length > len([]rune(f.end))))
			}
		}
	}
	var focused, enabled int32
	comCall(element, elementHasFocus, uintptr(unsafe.Pointer(&focused)))
	comCall(element, elementEnabled, uintptr(unsafe.Pointer(&enabled)))
	n.focused, n.disabled = focused != 0, enabled == 0
	if item := pattern(element, selectionItemID, &iidSelectionItem); item != 0 {
		var selected int32
		comCall(item, selectedGet, uintptr(unsafe.Pointer(&selected)))
		release(item)
		n.selected = selected != 0
	}
	if toggle := pattern(element, toggleID, &iidToggle); toggle != 0 {
		var state int32
		comCall(toggle, toggleGet, uintptr(unsafe.Pointer(&state)))
		release(toggle)
		n.checked = state == 1
	}
	var box windows.Rect
	if comCall(element, elementBounds, uintptr(unsafe.Pointer(&box))) == 0 && box.Right-box.Left > 1 && box.Bottom-box.Top > 1 {
		n.x, n.y, n.placed = float64(box.Left+box.Right)/2, float64(box.Top+box.Bottom)/2, true
	}
	if flattenedTypes[kind] && n.name == "" {
		w.children(element, depth)
		return
	}
	w.nodes = append(w.nodes, n)
	if !leafTypes[kind] {
		w.children(element, depth+1)
	}
}

func (w *uiaWalker) children(element uintptr, depth int) {
	var child uintptr
	comCall(w.walker, walkerFirstChild, element, uintptr(unsafe.Pointer(&child)))
	for child != 0 {
		w.visit(child, depth)
		var next uintptr
		comCall(w.walker, walkerNextSibling, child, uintptr(unsafe.Pointer(&next)))
		release(child)
		child = next
	}
}

// why: the foreground window can be on another display than the one looked at, and its elements say nothing about this one
func topOn(on display) uintptr {
	foreground := uintptr(windows.GetForegroundWindow())
	if within(foreground, on) {
		return foreground
	}
	for _, w := range topWindows() {
		if !hidden(w.handle) && within(w.handle, on) {
			return w.handle
		}
	}
	return foreground
}

func within(handle uintptr, on display) bool {
	var box windows.Rect
	if ok, _, _ := getWindowRect.Call(handle, uintptr(unsafe.Pointer(&box))); ok == 0 {
		return false
	}
	if minimized, _, _ := isIconic.Call(handle); minimized != 0 {
		return false
	}
	x, y := float64(box.Left+box.Right)/2, float64(box.Top+box.Bottom)/2
	return x >= on.x && x < on.x+on.w && y >= on.y && y < on.y+on.h
}

func elementString(element uintptr, property int) string {
	var text uintptr
	comCall(element, property, uintptr(unsafe.Pointer(&text)))
	return strings.TrimSpace(takeString(text))
}

func behind(front uintptr) []uiNode {
	var nodes []uiNode
	for _, w := range topWindows() {
		if w.handle == front || len(nodes) == uiOthers || hidden(w.handle) {
			continue
		}
		nodes = append(nodes, uiNode{role: "window", name: windowTitle(w.handle) + " (" + exeName(w.pid) + ", behind)", target: winRaise{w.handle}})
	}
	return nodes
}

type winRaise struct{ handle uintptr }

func (r winRaise) selects() bool { return false }

func (r winRaise) activate(bool) error {
	if minimized, _, _ := isIconic.Call(r.handle); minimized != 0 {
		showWindow.Call(r.handle, swRestore)
	}
	// why: Windows lets only the process that owns the foreground move it, so the host joins the front window's input queue for the call
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	front := windows.GetForegroundWindow()
	frontThread, _ := windows.GetWindowThreadProcessId(front, nil)
	ours := windows.GetCurrentThreadId()
	if frontThread != 0 && frontThread != ours {
		attachThreadInput.Call(uintptr(ours), uintptr(frontThread), 1)
		defer attachThreadInput.Call(uintptr(ours), uintptr(frontThread), 0)
	}
	bringWindowToTop.Call(r.handle)
	if ok, _, _ := setForegroundWindow.Call(r.handle); ok == 0 {
		return errors.New("Windows did not bring the window to the front")
	}
	return nil
}

func hidden(handle uintptr) bool {
	style, _, _ := getWindowLong.Call(handle, gwlExStyle)
	if style&(exToolWindow|exNoActivate) != 0 {
		return true
	}
	var cloaked uint32
	hr, _, _ := dwmAttribute.Call(handle, dwmCloaked, uintptr(unsafe.Pointer(&cloaked)), unsafe.Sizeof(cloaked))
	return hr == 0 && cloaked != 0
}
