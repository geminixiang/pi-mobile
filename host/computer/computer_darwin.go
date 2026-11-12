package computer

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/ebitengine/purego"
)

type cgPoint struct{ X, Y float64 }

type cgRect struct{ X, Y, W, H float64 }

const (
	leftDown, leftUp, rightDown, rightUp, mouseMoved, leftDragged = 1, 2, 3, 4, 5, 6
	otherDown, otherUp                                            = 25, 26
	clickState                                                    = 1
	hidTap                                                        = 0
	cfUTF8                                                        = 0x08000100
)

type modifier struct {
	code uint16
	flag uint64
}

var modifiers = map[string]modifier{
	"shift": {56, 0x20000}, "ctrl": {59, 0x40000}, "alt": {58, 0x80000}, "cmd": {55, 0x100000}, "fn": {63, 0x800000},
}

var keyCodes = map[string]uint16{
	"return": 36, "tab": 48, "space": 49, "backspace": 51, "esc": 53,
	"forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
	"left": 123, "right": 124, "down": 125, "up": 126,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
}

type macScreen struct {
	axTrusted        func() bool
	mainDisplay      func() uint32
	activeDisplays   func(uint32, *uint32, *uint32) int32
	displayBounds    func(uint32) cgRect
	eventCreate      func(uintptr) uintptr
	eventLocation    func(uintptr) cgPoint
	mouseEvent       func(uintptr, uint32, cgPoint, uint32) uintptr
	keyboardEvent    func(uintptr, uint16, bool) uintptr
	scrollEvent      func(uintptr, uint32, uint32, int32, int32, int32) uintptr
	setFlags         func(uintptr, uint64)
	setIntegerField  func(uintptr, uint32, int64)
	setUnicodeString func(uintptr, uint64, *uint16)
	post             func(uint32, uintptr)
	release          func(uintptr)
	stringCreate     func(uintptr, string, uint32) uintptr
	stringGet        func(uintptr, *byte, int64, uint32) bool
	appElement       func(int32) uintptr
	copyAttribute    func(uintptr, uintptr, *uintptr) int32
	clipboard        *pasteboard
	layout           *keyboardLayout
	ax               *axFocus
	tree             *axTree
	at               cgPoint
	dragging         bool
	flags            uint64
}

func newScreen(string) (screen, error) {
	lib, err := purego.Dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	s := &macScreen{}
	for name, fn := range map[string]any{
		"AXIsProcessTrusted": &s.axTrusted, "CGMainDisplayID": &s.mainDisplay, "CGGetActiveDisplayList": &s.activeDisplays, "CGDisplayBounds": &s.displayBounds,
		"CGEventCreate": &s.eventCreate, "CGEventGetLocation": &s.eventLocation,
		"CGEventCreateMouseEvent": &s.mouseEvent, "CGEventCreateKeyboardEvent": &s.keyboardEvent,
		"CGEventCreateScrollWheelEvent2": &s.scrollEvent, "CGEventSetFlags": &s.setFlags,
		"CGEventSetIntegerValueField": &s.setIntegerField, "CGEventKeyboardSetUnicodeString": &s.setUnicodeString,
		"CGEventPost": &s.post, "CFRelease": &s.release, "CFStringCreateWithCString": &s.stringCreate,
		"CFStringGetCString": &s.stringGet, "AXUIElementCreateApplication": &s.appElement,
		"AXUIElementCopyAttributeValue": &s.copyAttribute,
	} {
		purego.RegisterLibFunc(fn, lib, name)
	}
	s.ax = newAXFocus(lib, s.stringCreate)
	s.tree = newAXTree(lib, s)
	if clipboard, err := newPasteboard(); err == nil {
		s.clipboard = clipboard
	}
	if layout, err := newKeyboardLayout(s.release); err == nil {
		s.layout = layout
	}
	return s, nil
}

var errNoAccessibility = errors.New("macOS has not given pi-mobile Accessibility, so the mouse and keyboard do nothing: tell the user to turn on pi-mobile in System Settings › Privacy & Security › Accessibility on the computer")

func (s *macScreen) displays() ([]display, error) {
	ids := make([]uint32, 16)
	var count uint32
	if s.activeDisplays(uint32(len(ids)), &ids[0], &count) != 0 || count == 0 {
		return nil, errors.New("macOS lists no display")
	}
	main := s.mainDisplay()
	all := []display{}
	for _, id := range ids[:count] {
		b := s.displayBounds(id)
		d := display{b.X, b.Y, b.W, b.H}
		if id == main {
			all = append([]display{d}, all...)
			continue
		}
		all = append(all, d)
	}
	return all, nil
}

func (s *macScreen) capture(d display) (image.Image, error) {
	file, err := os.CreateTemp("", "pi-mobile-shot-*.jpg")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	file.Close()
	defer os.Remove(path)
	if out, err := exec.Command("/usr/sbin/screencapture", "-x", "-t", "jpg", "-R", fmt.Sprintf("%g,%g,%g,%g", d.x, d.y, d.w, d.h), path).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("screencapture: %v %s", err, strings.TrimSpace(string(out)))
	}
	file, err = os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	img, err := jpeg.Decode(file)
	if err != nil {
		return nil, errors.New("no screenshot: macOS has not given pi-mobile Screen Recording; tell the user to turn on pi-mobile in System Settings › Privacy & Security › Screen & System Audio Recording on the computer")
	}
	return img, nil
}

func (s *macScreen) attribute(element uintptr, name string) uintptr {
	key := s.stringCreate(0, name, cfUTF8)
	defer s.release(key)
	var value uintptr
	if s.copyAttribute(element, key, &value) != 0 {
		return 0
	}
	return value
}

func (s *macScreen) text(value uintptr) string {
	if value == 0 {
		return ""
	}
	defer s.release(value)
	buffer := make([]byte, 1024)
	if !s.stringGet(value, &buffer[0], int64(len(buffer)), cfUTF8) {
		return ""
	}
	return strings.TrimRight(string(buffer), "\x00")
}

func (s *macScreen) state() (string, string, float64, float64) {
	event := s.eventCreate(0)
	at := s.eventLocation(event)
	s.release(event)
	name, pid := frontApp()
	if pid == 0 || !s.axTrusted() {
		return name, "", at.X, at.Y
	}
	app := s.appElement(int32(pid))
	defer s.release(app)
	window := ""
	if w := s.attribute(app, "AXFocusedWindow"); w != 0 {
		window = s.text(s.attribute(w, "AXTitle"))
		s.release(w)
	}
	return name, window, at.X, at.Y
}

var lsappinfoPID = regexp.MustCompile(`\bpid = (\d+)`)
var lsappinfoName = regexp.MustCompile(`^"([^"]*)"`)

func frontApp() (string, int) {
	front, err := exec.Command("/usr/bin/lsappinfo", "front").Output()
	if err != nil {
		return "", 0
	}
	out, err := exec.Command("/usr/bin/lsappinfo", "info", "-only", "name", "-only", "pid", strings.TrimSpace(string(front))).Output()
	if err != nil {
		return "", 0
	}
	name := ""
	if m := lsappinfoName.FindSubmatch(out); m != nil {
		name = string(m[1])
	}
	pid := 0
	if m := lsappinfoPID.FindSubmatch(out); m != nil {
		pid, _ = strconv.Atoi(string(m[1]))
	}
	return name, pid
}

var (
	lsappinfoEntry  = regexp.MustCompile(`(?m)^\s*\d+\) "`)
	lsappinfoQuoted = regexp.MustCompile(`^([^"]*)"`)
)

func (s *macScreen) apps() map[int]string {
	out, err := exec.Command("/usr/bin/lsappinfo", "list").Output()
	if err != nil {
		return map[int]string{}
	}
	apps := map[int]string{}
	starts := lsappinfoEntry.FindAllIndex(out, -1)
	for i, start := range starts {
		end := len(out)
		if i+1 < len(starts) {
			end = starts[i+1][0]
		}
		entry := out[start[1]:end]
		name := lsappinfoQuoted.FindSubmatch(entry)
		pid := lsappinfoPID.FindSubmatch(entry)
		if name == nil || pid == nil || !bytes.Contains(entry, []byte(`type="Foreground"`)) {
			continue
		}
		if n, err := strconv.Atoi(string(pid[1])); err == nil {
			apps[n] = string(name[1])
		}
	}
	return apps
}

func (s *macScreen) quit(pids []int) {
	quitProcesses(pids)
}

func (s *macScreen) send(event uintptr) error {
	defer s.release(event)
	if !s.axTrusted() {
		return errNoAccessibility
	}
	s.post(hidTap, event)
	return nil
}

func (s *macScreen) mouse(kind uint32, x, y float64, button uint32, clicks int) error {
	event := s.mouseEvent(0, kind, cgPoint{x, y}, button)
	s.setFlags(event, s.flags)
	if clicks > 0 {
		s.setIntegerField(event, clickState, int64(clicks))
	}
	return s.send(event)
}

var macButtons = map[string]struct{ down, up, number uint32 }{
	"left":   {leftDown, leftUp, 0},
	"right":  {rightDown, rightUp, 1},
	"middle": {otherDown, otherUp, 2},
}

func (s *macScreen) pointer(x, y float64) error {
	s.at = cgPoint{x, y}
	kind := uint32(mouseMoved)
	if s.dragging {
		kind = leftDragged
	}
	return s.mouse(kind, x, y, 0, 0)
}

func (s *macScreen) button(name string, down bool, click int) error {
	button, ok := macButtons[name]
	if !ok {
		return fmt.Errorf("unknown button %q", name)
	}
	kind := button.up
	if down {
		kind = button.down
	}
	s.dragging = down && name == "left"
	return s.mouse(kind, s.at.X, s.at.Y, button.number, click)
}

func (s *macScreen) wheel(dx, dy int) error {
	return s.send(s.scrollEvent(0, 1, 2, int32(-dy), int32(-dx), 0))
}

func (s *macScreen) press(name string, down bool) error {
	if mod, ok := modifiers[name]; ok {
		if down {
			s.flags |= mod.flag
		} else {
			s.flags &^= mod.flag
		}
		return s.key(mod.code, down)
	}
	if code, ok := keyCodes[name]; ok {
		return s.key(code, down)
	}
	if s.layout == nil {
		return fmt.Errorf("unknown key %q: macOS gave no keyboard layout", name)
	}
	code, shift, ok := s.layout.find(name)
	if !ok {
		return fmt.Errorf("unknown key %q: the keyboard layout has no such key", name)
	}
	if !shift {
		return s.key(code, down)
	}
	if !down {
		return errors.Join(s.key(code, false), s.press("shift", false))
	}
	if err := s.press("shift", true); err != nil {
		return err
	}
	return s.key(code, true)
}

func (s *macScreen) key(code uint16, down bool) error {
	event := s.keyboardEvent(0, code, down)
	s.setFlags(event, s.flags)
	return s.send(event)
}

var errNoPasteboard = errors.New("the pasteboard could not be opened")

func (s *macScreen) holdClipboard() (func() error, error) {
	if s.clipboard == nil {
		return nil, errNoPasteboard
	}
	saved := s.clipboard.save()
	return func() error { s.clipboard.restore(saved); return nil }, nil
}

func (s *macScreen) putClipboard(text string) error {
	if s.clipboard == nil {
		return errNoPasteboard
	}
	s.clipboard.setText(text)
	return nil
}

func (s *macScreen) pasteKeys() string { return "cmd+v" }

func (s *macScreen) typeRunes(line string) error {
	for _, r := range line {
		units := utf16.Encode([]rune{r})
		for _, down := range []bool{true, false} {
			event := s.keyboardEvent(0, 0, down)
			s.setUnicodeString(event, uint64(len(units)), &units[0])
			if err := s.send(event); err != nil {
				return err
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	return nil
}
