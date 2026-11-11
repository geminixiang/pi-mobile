//go:build linux

package main

import (
	"errors"
	"fmt"
	"image"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
)

type keyPlace struct {
	code  xproto.Keycode
	shift bool
}

type x11Screen struct {
	mu        sync.Mutex
	conn      *xgb.Conn
	root      xproto.Window
	setup     *xproto.SetupInfo
	perCode   int
	keysyms   []xproto.Keysym
	spare     []xproto.Keycode
	shiftCode xproto.Keycode
	atoms     map[string]xproto.Atom
	clip      *selection
	randr     bool
}

func newX11Screen(display string) (*x11Screen, error) {
	conn, err := xgb.NewConnDisplay(display)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the X11 display %s: %w", display, err)
	}
	if err := xtest.Init(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("the X11 display %s has no XTEST, so the mouse and keyboard cannot be driven: %w", display, err)
	}
	setup := xproto.Setup(conn)
	s := &x11Screen{conn: conn, root: setup.DefaultScreen(conn).Root, setup: setup, atoms: map[string]xproto.Atom{}, randr: randr.Init(conn) == nil}
	if err := s.loadKeymap(); err != nil {
		conn.Close()
		return nil, err
	}
	return s, nil
}

func (s *x11Screen) loadKeymap() error {
	first, last := s.setup.MinKeycode, s.setup.MaxKeycode
	reply, err := xproto.GetKeyboardMapping(s.conn, first, byte(last-first+1)).Reply()
	if err != nil {
		return fmt.Errorf("read the keyboard map: %w", err)
	}
	s.perCode, s.keysyms, s.spare = int(reply.KeysymsPerKeycode), reply.Keysyms, nil
	for code := int(first); code <= int(last); code++ {
		row := s.keysyms[(code-int(first))*s.perCode : (code-int(first)+1)*s.perCode]
		if allZero(row) {
			s.spare = append(s.spare, xproto.Keycode(code))
		}
	}
	shift, ok := s.place(modifierKeysyms["shift"])
	if !ok {
		return errors.New("the keyboard map has no Shift key")
	}
	s.shiftCode = shift.code
	return nil
}

func allZero(row []xproto.Keysym) bool {
	for _, sym := range row {
		if sym != 0 {
			return false
		}
	}
	return true
}

func (s *x11Screen) place(sym uint32) (keyPlace, bool) {
	first := int(s.setup.MinKeycode)
	for column := 0; column < min(s.perCode, 2); column++ {
		for i := column; i < len(s.keysyms); i += s.perCode {
			if uint32(s.keysyms[i]) == sym {
				return keyPlace{code: xproto.Keycode(first + i/s.perCode), shift: column == 1}, true
			}
		}
	}
	return keyPlace{}, false
}

func (s *x11Screen) displays() ([]display, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	screen := s.setup.DefaultScreen(s.conn)
	whole := []display{{0, 0, float64(screen.WidthInPixels), float64(screen.HeightInPixels)}}
	if !s.randr {
		return whole, nil
	}
	resources, err := randr.GetScreenResourcesCurrent(s.conn, s.root).Reply()
	if err != nil {
		return whole, nil
	}
	var primaryCrtc randr.Crtc
	if primary, err := randr.GetOutputPrimary(s.conn, s.root).Reply(); err == nil && primary.Output != 0 {
		if output, err := randr.GetOutputInfo(s.conn, primary.Output, 0).Reply(); err == nil {
			primaryCrtc = output.Crtc
		}
	}
	var all []display
	for _, id := range resources.Crtcs {
		crtc, err := randr.GetCrtcInfo(s.conn, id, 0).Reply()
		if err != nil || crtc.Width == 0 {
			continue
		}
		d := display{float64(crtc.X), float64(crtc.Y), float64(crtc.Width), float64(crtc.Height)}
		if id == primaryCrtc {
			all = append([]display{d}, all...)
		} else {
			all = append(all, d)
		}
	}
	if len(all) == 0 {
		return whole, nil
	}
	return all, nil
}

func (s *x11Screen) capture(d display) (image.Image, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	width, height := int(d.w), int(d.h)
	reply, err := xproto.GetImage(s.conn, xproto.ImageFormatZPixmap, xproto.Drawable(s.root), int16(d.x), int16(d.y), uint16(width), uint16(height), 0xffffffff).Reply()
	if err != nil {
		return nil, fmt.Errorf("X11 screenshot: %w", err)
	}
	return zpixmap(reply.Data, reply.Depth, width, height, s.setup)
}

func (s *x11Screen) atom(name string) xproto.Atom {
	if atom, ok := s.atoms[name]; ok {
		return atom
	}
	reply, err := xproto.InternAtom(s.conn, false, uint16(len(name)), name).Reply()
	if err != nil {
		return 0
	}
	s.atoms[name] = reply.Atom
	return reply.Atom
}

func (s *x11Screen) property(window xproto.Window, name string) []byte {
	reply, err := xproto.GetProperty(s.conn, false, window, s.atom(name), xproto.GetPropertyTypeAny, 0, 1<<16).Reply()
	if err != nil {
		return nil
	}
	return reply.Value
}

func (s *x11Screen) windows(name string) []xproto.Window {
	value := s.property(s.root, name)
	out := make([]xproto.Window, 0, len(value)/4)
	for i := 0; i+4 <= len(value); i += 4 {
		out = append(out, xproto.Window(xgb.Get32(value[i:])))
	}
	return out
}

func (s *x11Screen) pid(window xproto.Window) int {
	value := s.property(window, "_NET_WM_PID")
	if len(value) < 4 {
		return 0
	}
	return int(xgb.Get32(value))
}

func processName(pid int) string {
	comm, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(comm))
}

func (s *x11Screen) state() (string, string, float64, float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	px, py := 0.0, 0.0
	if pointer, err := xproto.QueryPointer(s.conn, s.root).Reply(); err == nil {
		px, py = float64(pointer.RootX), float64(pointer.RootY)
	}
	active := s.windows("_NET_ACTIVE_WINDOW")
	if len(active) == 0 || active[0] == 0 {
		return "", "", px, py
	}
	title := string(s.property(active[0], "_NET_WM_NAME"))
	if title == "" {
		title = string(s.property(active[0], "WM_NAME"))
	}
	app := ""
	if pid := s.pid(active[0]); pid != 0 {
		app = processName(pid)
	}
	return app, title, px, py
}

func (s *x11Screen) apps() map[int]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	apps := map[int]string{}
	for _, window := range s.windows("_NET_CLIENT_LIST") {
		if pid := s.pid(window); pid != 0 {
			apps[pid] = processName(pid)
		}
	}
	return apps
}

func (s *x11Screen) quit(pids []int) {
	quitProcesses(pids)
}

func (s *x11Screen) fake(kind byte, detail byte, x, y int16) {
	xtest.FakeInput(s.conn, kind, detail, 0, s.root, x, y, 0)
}

func (s *x11Screen) sync() {
	_, _ = xproto.GetInputFocus(s.conn).Reply()
}

func (s *x11Screen) pointer(x, y float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fake(xproto.MotionNotify, 0, int16(math.Round(x)), int16(math.Round(y)))
	s.sync()
	return nil
}

var x11Buttons = map[string]byte{"left": 1, "middle": 2, "right": 3}

func (s *x11Screen) button(name string, down bool, _ int) error {
	button, ok := x11Buttons[name]
	if !ok {
		return fmt.Errorf("unknown button %q", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kind := byte(xproto.ButtonRelease)
	if down {
		kind = xproto.ButtonPress
	}
	s.fake(kind, button, 0, 0)
	s.sync()
	return nil
}

func (s *x11Screen) wheel(dx, dy int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	turn := func(lines int, back, forward byte) {
		button := forward
		if lines < 0 {
			button, lines = back, -lines
		}
		for range lines {
			s.fake(xproto.ButtonPress, button, 0, 0)
			s.fake(xproto.ButtonRelease, button, 0, 0)
		}
	}
	turn(dy, 4, 5)
	turn(dx, 6, 7)
	s.sync()
	return nil
}

func (s *x11Screen) press(name string, down bool) error {
	sym, ok := keysymOf(name)
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	place, ok := s.place(sym)
	if !ok {
		return fmt.Errorf("the keyboard layout has no key %q", name)
	}
	s.key(place, down)
	s.sync()
	return nil
}

func (s *x11Screen) key(place keyPlace, down bool) {
	kind := byte(xproto.KeyRelease)
	if down {
		kind = xproto.KeyPress
	}
	if down && place.shift {
		s.fake(xproto.KeyPress, byte(s.shiftCode), 0, 0)
	}
	s.fake(kind, byte(place.code), 0, 0)
	if !down && place.shift {
		s.fake(xproto.KeyRelease, byte(s.shiftCode), 0, 0)
	}
}

func (s *x11Screen) tap(place keyPlace) {
	s.key(place, true)
	s.key(place, false)
	s.sync()
	time.Sleep(5 * time.Millisecond)
}

func (s *x11Screen) typeRunes(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	runes := []rune(text)
	for len(runes) > 0 {
		if place, ok := s.place(runeKeysym(runes[0])); ok {
			s.tap(place)
			runes = runes[1:]
			continue
		}
		typed, err := s.typeRemapped(runes)
		if err != nil {
			return err
		}
		runes = runes[typed:]
	}
	return nil
}

func (s *x11Screen) typeRemapped(runes []rune) (int, error) {
	if len(s.spare) == 0 {
		return 0, fmt.Errorf("the keyboard map has no free key to type %q with", string(runes[0]))
	}
	assigned := map[rune]xproto.Keycode{}
	batch := 0
	for _, r := range runes {
		if _, ok := s.place(runeKeysym(r)); ok {
			break
		}
		if _, ok := assigned[r]; !ok {
			if len(assigned) == len(s.spare) {
				break
			}
			code := s.spare[len(assigned)]
			assigned[r] = code
			row := make([]xproto.Keysym, s.perCode)
			for i := range row {
				row[i] = xproto.Keysym(runeKeysym(r))
			}
			xproto.ChangeKeyboardMapping(s.conn, 1, code, byte(s.perCode), row)
		}
		batch++
	}
	s.sync()
	time.Sleep(30 * time.Millisecond)
	for _, r := range runes[:batch] {
		s.tap(keyPlace{code: assigned[r]})
	}
	// why: a client looks the keysym up when it handles the event, so restoring the key at once can turn the last letters into nothing (xdotool waits too).
	time.Sleep(50 * time.Millisecond)
	for _, code := range assigned {
		xproto.ChangeKeyboardMapping(s.conn, 1, code, byte(s.perCode), make([]xproto.Keysym, s.perCode))
	}
	s.sync()
	return batch, nil
}
