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
	s := &x11Screen{conn: conn, root: setup.DefaultScreen(conn).Root, setup: setup, atoms: map[string]xproto.Atom{}}
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

func (s *x11Screen) monitor() (x, y, width, height int) {
	screen := s.setup.DefaultScreen(s.conn)
	x, y, width, height = 0, 0, int(screen.WidthInPixels), int(screen.HeightInPixels)
	if randr.Init(s.conn) != nil {
		return
	}
	primary, err := randr.GetOutputPrimary(s.conn, s.root).Reply()
	if err != nil || primary.Output == 0 {
		return
	}
	output, err := randr.GetOutputInfo(s.conn, primary.Output, 0).Reply()
	if err != nil || output.Crtc == 0 {
		return
	}
	crtc, err := randr.GetCrtcInfo(s.conn, output.Crtc, 0).Reply()
	if err != nil || crtc.Width == 0 {
		return
	}
	return int(crtc.X), int(crtc.Y), int(crtc.Width), int(crtc.Height)
}

func (s *x11Screen) capture() (image.Image, float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	x, y, width, height := s.monitor()
	reply, err := xproto.GetImage(s.conn, xproto.ImageFormatZPixmap, xproto.Drawable(s.root), int16(x), int16(y), uint16(width), uint16(height), 0xffffffff).Reply()
	if err != nil {
		return nil, 0, fmt.Errorf("X11 screenshot: %w", err)
	}
	img, err := zpixmap(reply.Data, reply.Depth, width, height, s.setup)
	if err != nil {
		return nil, 0, err
	}
	return img, float64(width), nil
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
	originX, originY, _, _ := s.monitor()
	px, py := 0.0, 0.0
	if pointer, err := xproto.QueryPointer(s.conn, s.root).Reply(); err == nil {
		px, py = float64(int(pointer.RootX)-originX), float64(int(pointer.RootY)-originY)
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

func (s *x11Screen) rootPoint(x, y float64) (int16, int16) {
	originX, originY, _, _ := s.monitor()
	return int16(int(math.Round(x)) + originX), int16(int(math.Round(y)) + originY)
}

func (s *x11Screen) move(x, y float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rx, ry := s.rootPoint(x, y)
	s.fake(xproto.MotionNotify, 0, rx, ry)
	s.sync()
	return nil
}

var x11Buttons = map[string]byte{"left": 1, "middle": 2, "right": 3}

func (s *x11Screen) click(x, y float64, button string, count int) error {
	if err := s.move(x, y); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	time.Sleep(30 * time.Millisecond)
	for range count {
		s.fake(xproto.ButtonPress, x11Buttons[button], 0, 0)
		s.fake(xproto.ButtonRelease, x11Buttons[button], 0, 0)
	}
	s.sync()
	return nil
}

func (s *x11Screen) drag(x, y, toX, toY float64) error {
	if err := s.move(x, y); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fake(xproto.ButtonPress, 1, 0, 0)
	const steps = 12
	for i := 1; i <= steps; i++ {
		time.Sleep(15 * time.Millisecond)
		rx, ry := s.rootPoint(x+(toX-x)*float64(i)/steps, y+(toY-y)*float64(i)/steps)
		s.fake(xproto.MotionNotify, 0, rx, ry)
		s.sync()
	}
	s.fake(xproto.ButtonRelease, 1, 0, 0)
	s.sync()
	return nil
}

func (s *x11Screen) scroll(x, y float64, dx, dy int) error {
	if err := s.move(x, y); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	wheel := func(lines int, back, forward byte) {
		button := forward
		if lines < 0 {
			button, lines = back, -lines
		}
		for range lines {
			s.fake(xproto.ButtonPress, button, 0, 0)
			s.fake(xproto.ButtonRelease, button, 0, 0)
		}
	}
	wheel(dy, 4, 5)
	wheel(dx, 6, 7)
	s.sync()
	return nil
}

func (s *x11Screen) key(keys string) error {
	mods, sym, err := chordKeysyms(keys)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	held := make([]xproto.Keycode, 0, len(mods))
	for _, mod := range mods {
		place, ok := s.place(mod)
		if !ok {
			return fmt.Errorf("the keyboard map has no key for a modifier in %q", keys)
		}
		held = append(held, place.code)
	}
	target, ok := s.place(sym)
	if !ok {
		return fmt.Errorf("the keyboard layout has no key %q", keys)
	}
	for _, code := range held {
		s.fake(xproto.KeyPress, byte(code), 0, 0)
	}
	s.fake(xproto.KeyPress, byte(target.code), 0, 0)
	s.fake(xproto.KeyRelease, byte(target.code), 0, 0)
	for i := len(held) - 1; i >= 0; i-- {
		s.fake(xproto.KeyRelease, byte(held[i]), 0, 0)
	}
	s.sync()
	return nil
}

func (s *x11Screen) tap(place keyPlace) {
	if place.shift {
		s.fake(xproto.KeyPress, byte(s.shiftCode), 0, 0)
	}
	s.fake(xproto.KeyPress, byte(place.code), 0, 0)
	s.fake(xproto.KeyRelease, byte(place.code), 0, 0)
	if place.shift {
		s.fake(xproto.KeyRelease, byte(s.shiftCode), 0, 0)
	}
	s.sync()
	time.Sleep(5 * time.Millisecond)
}

func (s *x11Screen) typeText(text string) error {
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
