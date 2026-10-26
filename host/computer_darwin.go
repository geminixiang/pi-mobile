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
	"syscall"
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
}

func newScreen() (screen, error) {
	lib, err := purego.Dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	s := &macScreen{}
	for name, fn := range map[string]any{
		"AXIsProcessTrusted": &s.axTrusted, "CGMainDisplayID": &s.mainDisplay, "CGDisplayPixelsWide": &s.displayWide,
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
	return s, nil
}

var errNoAccessibility = errors.New("macOS has not given pi-mobile Accessibility, so the mouse and keyboard do nothing: tell the user to turn on pi-mobile in System Settings › Privacy & Security › Accessibility on the computer")

func (s *macScreen) capture() (image.Image, float64, error) {
	file, err := os.CreateTemp("", "pi-mobile-shot-*.jpg")
	if err != nil {
		return nil, 0, err
	}
	path := file.Name()
	file.Close()
	defer os.Remove(path)
	if out, err := exec.Command("/usr/sbin/screencapture", "-x", "-m", "-t", "jpg", path).CombinedOutput(); err != nil {
		return nil, 0, fmt.Errorf("screencapture: %v %s", err, strings.TrimSpace(string(out)))
	}
	file, err = os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	img, err := jpeg.Decode(file)
	if err != nil {
		return nil, 0, errors.New("no screenshot: macOS has not given pi-mobile Screen Recording; tell the user to turn on pi-mobile in System Settings › Privacy & Security › Screen & System Audio Recording on the computer")
	}
	return img, float64(s.displayWide(s.mainDisplay())), nil
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
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	for _, pid := range pids {
		for syscall.Kill(pid, 0) == nil && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

func (s *macScreen) send(event uintptr) {
	s.post(hidTap, event)
	s.release(event)
}

func (s *macScreen) mouse(kind uint32, x, y float64, button uint32, clicks int) {
	event := s.mouseEvent(0, kind, cgPoint{x, y}, button)
	if clicks > 0 {
		s.setIntegerField(event, clickState, int64(clicks))
	}
	s.send(event)
}

func (s *macScreen) move(x, y float64) error {
	if !s.axTrusted() {
		return errNoAccessibility
	}
	s.mouse(mouseMoved, x, y, 0, 0)
	return nil
}

func (s *macScreen) click(x, y float64, button string, count int) error {
	down, up, number := uint32(leftDown), uint32(leftUp), uint32(0)
	switch button {
	case "right":
		down, up, number = rightDown, rightUp, 1
	case "middle":
		down, up, number = otherDown, otherUp, 2
	}
	if err := s.move(x, y); err != nil {
		return err
	}
	time.Sleep(30 * time.Millisecond)
	for i := 1; i <= count; i++ {
		s.mouse(down, x, y, number, i)
		s.mouse(up, x, y, number, i)
	}
	return nil
}

func (s *macScreen) drag(x, y, toX, toY float64) error {
	if err := s.move(x, y); err != nil {
		return err
	}
	s.mouse(leftDown, x, y, 0, 1)
	const steps = 12
	for i := 1; i <= steps; i++ {
		time.Sleep(15 * time.Millisecond)
		s.mouse(leftDragged, x+(toX-x)*float64(i)/steps, y+(toY-y)*float64(i)/steps, 0, 0)
	}
	s.mouse(leftUp, toX, toY, 0, 1)
	return nil
}

func (s *macScreen) scroll(x, y float64, dx, dy int) error {
	if err := s.move(x, y); err != nil {
		return err
	}
	s.send(s.scrollEvent(0, 1, 2, int32(-dy), int32(-dx), 0))
	return nil
}

func (s *macScreen) key(keys string) error {
	if !s.axTrusted() {
		return errNoAccessibility
	}
	mods, name, err := keyChord(keys)
	if err != nil {
		return err
	}
	held := make([]modifier, 0, len(mods))
	for _, m := range mods {
		mod, ok := modifiers[m]
		if !ok {
			return fmt.Errorf("unknown modifier %q in %q", m, keys)
		}
		held = append(held, mod)
	}
	code, ok := keyCodes[name]
	if !ok {
		return fmt.Errorf("unknown key %q in %q", name, keys)
	}
	press := func(code uint16, down bool, flags uint64) {
		event := s.keyboardEvent(0, code, down)
		s.setFlags(event, flags)
		s.send(event)
	}
	var flags uint64
	for _, m := range held {
		flags |= m.flag
		press(m.code, true, flags)
	}
	press(code, true, flags)
	press(code, false, flags)
	for i := len(held) - 1; i >= 0; i-- {
		flags &^= held[i].flag
		press(held[i].code, false, flags)
	}
	return nil
}

func (s *macScreen) typeText(text string) error {
	if !s.axTrusted() {
		return errNoAccessibility
	}
	for i, line := range strings.Split(text, "\n") {
		if i > 0 {
			if err := s.key("return"); err != nil {
				return err
			}
		}
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
	return nil
}
