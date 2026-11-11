package main

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

const (
	leftDown, leftUp, rightDown, rightUp, mouseMoved, leftDragged = 1, 2, 3, 4, 5, 6
	otherDown, otherUp                                            = 25, 26
	clickState                                                    = 1
	hidTap                                                        = 0
	utf8Encoding                                                  = 0x08000100
)

type modifier struct {
	code uint16
	flag uint64
}

var modifiers = map[string]modifier{
	"shift": {56, 0x20000}, "ctrl": {59, 0x40000}, "control": {59, 0x40000},
	"alt": {58, 0x80000}, "option": {58, 0x80000}, "opt": {58, 0x80000},
	"cmd": {55, 0x100000}, "command": {55, 0x100000}, "meta": {55, 0x100000}, "super": {55, 0x100000},
	"fn": {63, 0x800000},
}

var keyCodes = map[string]uint16{
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
	"r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
	"8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
	"\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
	"return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "esc": 53, "escape": 53,
	"forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
	"left": 123, "right": 124, "down": 125, "up": 126,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
}

type macScreen struct {
	axTrusted        func() bool
	mainDisplay      func() uint32
	displayWide      func(uint32) uintptr
	displayHigh      func(uint32) uintptr
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
	at               cgPoint
	held             string
	flags            uint64
}

func newScreen() (screen, error) {
	lib, err := purego.Dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	s := &macScreen{}
	for name, fn := range map[string]any{
		"AXIsProcessTrusted": &s.axTrusted, "CGMainDisplayID": &s.mainDisplay, "CGDisplayPixelsWide": &s.displayWide, "CGDisplayPixelsHigh": &s.displayHigh,
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
	if clipboard, err := newPasteboard(); err == nil {
		s.clipboard = clipboard
	}
	return s, nil
}

var errNoAccessibility = errors.New("macOS has not given pi-mobile Accessibility, so the mouse and keyboard do nothing: tell the user to turn on pi-mobile in System Settings › Privacy & Security › Accessibility on the computer")

func (s *macScreen) displays() ([]display, error) {
	main := s.mainDisplay()
	return []display{{0, 0, float64(s.displayWide(main)), float64(s.displayHigh(main))}}, nil
}

func (s *macScreen) capture(display) (image.Image, error) {
	file, err := os.CreateTemp("", "pi-mobile-shot-*.jpg")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	file.Close()
	defer os.Remove(path)
	if out, err := exec.Command("/usr/sbin/screencapture", "-x", "-m", "-t", "jpg", path).CombinedOutput(); err != nil {
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
	key := s.stringCreate(0, name, utf8Encoding)
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
	if !s.stringGet(value, &buffer[0], int64(len(buffer)), utf8Encoding) {
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
	out, err := exec.Command("/bin/sh", "-c", "a=$(/usr/bin/lsappinfo front) && /usr/bin/lsappinfo info -only name $a && /usr/bin/lsappinfo info -only pid $a").Output()
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

func (s *macScreen) send(event uintptr) {
	s.post(hidTap, event)
	s.release(event)
}

func (s *macScreen) mouse(kind uint32, x, y float64, button uint32, clicks int) {
	event := s.mouseEvent(0, kind, cgPoint{x, y}, button)
	s.setFlags(event, s.flags)
	if clicks > 0 {
		s.setIntegerField(event, clickState, int64(clicks))
	}
	s.send(event)
}

var macButtons = map[string]struct{ down, up, number uint32 }{
	"left":   {leftDown, leftUp, 0},
	"right":  {rightDown, rightUp, 1},
	"middle": {otherDown, otherUp, 2},
}

func (s *macScreen) pointer(x, y float64) error {
	if !s.axTrusted() {
		return errNoAccessibility
	}
	s.at = cgPoint{x, y}
	kind := uint32(mouseMoved)
	if s.held == "left" {
		kind = leftDragged
	}
	s.mouse(kind, x, y, 0, 0)
	return nil
}

func (s *macScreen) button(name string, down bool, click int) error {
	if !s.axTrusted() {
		return errNoAccessibility
	}
	button, ok := macButtons[name]
	if !ok {
		return fmt.Errorf("unknown button %q", name)
	}
	kind := button.up
	s.held = ""
	if down {
		kind, s.held = button.down, name
	}
	s.mouse(kind, s.at.X, s.at.Y, button.number, click)
	return nil
}

func (s *macScreen) wheel(dx, dy int) error {
	if !s.axTrusted() {
		return errNoAccessibility
	}
	s.send(s.scrollEvent(0, 1, 2, int32(-dy), int32(-dx), 0))
	return nil
}

func (s *macScreen) press(name string, down bool) error {
	if !s.axTrusted() {
		return errNoAccessibility
	}
	if base, ok := shiftedKeys[name]; ok {
		return s.pressShifted(base, down)
	}
	code, ok := keyCodes[name]
	if mod, isModifier := modifiers[name]; isModifier {
		code, ok = mod.code, true
		if down {
			s.flags |= mod.flag
		} else {
			s.flags &^= mod.flag
		}
	}
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	event := s.keyboardEvent(0, code, down)
	s.setFlags(event, s.flags)
	s.send(event)
	return nil
}

var shiftedKeys = map[string]string{
	"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
	"_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
}

func (s *macScreen) pressShifted(base string, down bool) error {
	if !down {
		return errors.Join(s.press(base, false), s.press("shift", false))
	}
	if err := s.press("shift", true); err != nil {
		return err
	}
	return s.press(base, true)
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
	if !s.axTrusted() {
		return errNoAccessibility
	}
	s.typeKeys(line)
	return nil
}

func (s *macScreen) typeKeys(line string) {
	for _, r := range line {
		units := utf16.Encode([]rune{r})
		for _, down := range []bool{true, false} {
			event := s.keyboardEvent(0, 0, down)
			s.setUnicodeString(event, uint64(len(units)), &units[0])
			s.send(event)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
