//go:build linux

package main

import (
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	portalName     = "org.freedesktop.portal.Desktop"
	portalPath     = dbus.ObjectPath("/org/freedesktop/portal/desktop")
	remoteDesktop  = "org.freedesktop.portal.RemoteDesktop"
	portalClip     = "org.freedesktop.portal.Clipboard"
	portalAnswer   = 2 * time.Minute
	keyboardDevice = 1
	pointerDevice  = 2
	monitorSource  = 1
	persistAlways  = 2
	plainText      = "text/plain;charset=utf-8"
)

var portalButtons = map[string]int32{"left": 0x110, "right": 0x111, "middle": 0x112}

type remoteSession struct {
	streamArea
	handle    dbus.ObjectPath
	stream    uint32
	clipboard bool
}

type portalScreen struct {
	mu       sync.Mutex
	bus      *dbus.Conn
	desktop  dbus.BusObject
	tokens   int
	session  *remoteSession
	px, py   float64
	pasteMu  sync.Mutex
	pasteNow string
}

var errPortalDenied = errors.New("the user declined on the computer: GNOME or KDE asked whether pi-mobile may see the screen and use the mouse and keyboard, and the answer was no; tell the user to allow it there next time")

func newPortalScreen() (screen, error) {
	bus, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("Wayland: cannot reach the desktop's session bus: %w", err)
	}
	s := &portalScreen{bus: bus, desktop: bus.Object(portalName, portalPath)}
	if _, err := s.desktop.GetProperty(remoteDesktop + ".AvailableDeviceTypes"); err != nil {
		bus.Close()
		return nil, fmt.Errorf("Wayland: this desktop has no remote desktop portal (xdg-desktop-portal with a GNOME or KDE backend), so pi-mobile cannot see the screen or use the mouse and keyboard: %w", err)
	}
	return s, nil
}

func (s *portalScreen) request(method string, options map[string]dbus.Variant, args ...any) (map[string]dbus.Variant, error) {
	s.tokens++
	token := fmt.Sprintf("pimobile%d_%d", os.Getpid(), s.tokens)
	sender := strings.ReplaceAll(strings.TrimPrefix(s.bus.Names()[0], ":"), ".", "_")
	path := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + sender + "/" + token)
	match := []dbus.MatchOption{dbus.WithMatchObjectPath(path), dbus.WithMatchInterface("org.freedesktop.portal.Request"), dbus.WithMatchMember("Response")}
	if err := s.bus.AddMatchSignal(match...); err != nil {
		return nil, err
	}
	defer s.bus.RemoveMatchSignal(match...)
	answers := make(chan *dbus.Signal, 4)
	s.bus.Signal(answers)
	defer s.bus.RemoveSignal(answers)
	options["handle_token"] = dbus.MakeVariant(token)
	if err := s.desktop.Call(method, 0, append(args, options)...).Err; err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	deadline := time.After(portalAnswer)
	for {
		select {
		case signal := <-answers:
			if signal.Path != path || len(signal.Body) < 2 {
				continue
			}
			code, _ := signal.Body[0].(uint32)
			results, _ := signal.Body[1].(map[string]dbus.Variant)
			switch code {
			case 0:
				return results, nil
			case 1:
				return nil, errPortalDenied
			}
			return nil, fmt.Errorf("%s: the desktop ended the request (the dialog was closed or timed out on the computer)", method)
		case <-deadline:
			return nil, fmt.Errorf("%s: nobody answered the dialog on the computer within %s", method, portalAnswer)
		}
	}
}

func restoreTokenFile() string {
	return filepath.Join(stateDir(), "remote-desktop-token")
}

func (s *portalScreen) start() (*remoteSession, error) {
	if s.session != nil {
		return s.session, nil
	}
	created, err := s.request(remoteDesktop+".CreateSession", map[string]dbus.Variant{"session_handle_token": dbus.MakeVariant(fmt.Sprintf("pimobile%d", os.Getpid()))})
	if err != nil {
		return nil, err
	}
	var handle string
	if err := created["session_handle"].Store(&handle); err != nil {
		return nil, fmt.Errorf("CreateSession gave no session: %w", err)
	}
	session := dbus.ObjectPath(handle)
	devices := map[string]dbus.Variant{"types": dbus.MakeVariant(uint32(keyboardDevice | pointerDevice)), "persist_mode": dbus.MakeVariant(uint32(persistAlways))}
	if token, err := os.ReadFile(restoreTokenFile()); err == nil && len(token) > 0 {
		devices["restore_token"] = dbus.MakeVariant(strings.TrimSpace(string(token)))
	}
	if _, err := s.request(remoteDesktop+".SelectDevices", devices, session); err != nil {
		return nil, err
	}
	if _, err := s.request("org.freedesktop.portal.ScreenCast.SelectSources", map[string]dbus.Variant{"types": dbus.MakeVariant(uint32(monitorSource)), "multiple": dbus.MakeVariant(false)}, session); err != nil {
		return nil, err
	}
	clipboard := s.desktop.Call(portalClip+".RequestClipboard", 0, session, map[string]dbus.Variant{}).Err == nil
	started, err := s.request(remoteDesktop+".Start", map[string]dbus.Variant{}, session, "")
	if err != nil {
		return nil, err
	}
	if token, ok := started["restore_token"].Value().(string); ok {
		_ = os.WriteFile(restoreTokenFile(), []byte(token), 0o600)
	}
	var streams []struct {
		Node  uint32
		Props map[string]dbus.Variant
	}
	if err := started["streams"].Store(&streams); err != nil || len(streams) == 0 {
		return nil, errors.New("the desktop shared no screen, so clicks have nowhere to land: start again and pick the main screen in the dialog")
	}
	at, size := streamPair(streams[0].Props["position"]), streamPair(streams[0].Props["size"])
	if size[0] == 0 || size[1] == 0 {
		return nil, errors.New("the desktop shared a screen without its size")
	}
	s.session = &remoteSession{streamArea: streamArea{x: at[0], y: at[1], width: size[0], height: size[1]}, handle: session, stream: streams[0].Node, clipboard: clipboard}
	if clipboard {
		go s.answerPastes(session)
	}
	return s.session, nil
}

func streamPair(value dbus.Variant) [2]float64 {
	var pair struct{ A, B int32 }
	if value.Store(&pair) != nil {
		return [2]float64{}
	}
	return [2]float64{float64(pair.A), float64(pair.B)}
}

func (s *portalScreen) displays() ([]display, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.start()
	if err != nil {
		return nil, err
	}
	return []display{{0, 0, session.width, session.height}}, nil
}

func (s *portalScreen) capture(display) (image.Image, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.start()
	if err != nil {
		return nil, err
	}
	results, err := s.request("org.freedesktop.portal.Screenshot.Screenshot", map[string]dbus.Variant{"interactive": dbus.MakeVariant(false)}, "")
	if err != nil {
		return nil, err
	}
	uri, _ := results["uri"].Value().(string)
	address, err := url.Parse(uri)
	if err != nil || address.Scheme != "file" {
		return nil, fmt.Errorf("the screenshot portal answered %q, not a file", uri)
	}
	defer os.Remove(address.Path)
	file, err := os.Open(address.Path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	img, _, err := image.Decode(file)
	if err != nil {
		return nil, fmt.Errorf("the screenshot portal's file: %w", err)
	}
	return cropToStream(img, session.streamArea), nil
}

func (s *portalScreen) state() (string, string, float64, float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return "", "", s.px, s.py
}

func (s *portalScreen) apps() map[int]string { return map[int]string{} }

func (s *portalScreen) quit([]int) {}

func (s *portalScreen) notify(method string, args ...any) error {
	session, err := s.start()
	if err != nil {
		return err
	}
	all := append([]any{session.handle, map[string]dbus.Variant{}}, args...)
	if err := s.desktop.Call(remoteDesktop+"."+method, 0, all...).Err; err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	return nil
}

func (s *portalScreen) moveLocked(x, y float64) error {
	session, err := s.start()
	if err != nil {
		return err
	}
	s.px, s.py = x, y
	return s.notify("NotifyPointerMotionAbsolute", session.stream, x, y)
}

func (s *portalScreen) move(x, y float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.moveLocked(x, y)
}

func (s *portalScreen) button(button int32, count int) error {
	for range count {
		for _, state := range []uint32{1, 0} {
			if err := s.notify("NotifyPointerButton", button, state); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *portalScreen) click(x, y float64, button string, count int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.moveLocked(x, y); err != nil {
		return err
	}
	time.Sleep(30 * time.Millisecond)
	return s.button(portalButtons[button], count)
}

func (s *portalScreen) drag(x, y, toX, toY float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.moveLocked(x, y); err != nil {
		return err
	}
	if err := s.notify("NotifyPointerButton", portalButtons["left"], uint32(1)); err != nil {
		return err
	}
	const steps = 12
	for i := 1; i <= steps; i++ {
		time.Sleep(15 * time.Millisecond)
		if err := s.moveLocked(x+(toX-x)*float64(i)/steps, y+(toY-y)*float64(i)/steps); err != nil {
			return err
		}
	}
	return s.notify("NotifyPointerButton", portalButtons["left"], uint32(0))
}

func (s *portalScreen) scroll(x, y float64, dx, dy int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.moveLocked(x, y); err != nil {
		return err
	}
	if dy != 0 {
		if err := s.notify("NotifyPointerAxisDiscrete", uint32(0), int32(dy)); err != nil {
			return err
		}
	}
	if dx != 0 {
		return s.notify("NotifyPointerAxisDiscrete", uint32(1), int32(dx))
	}
	return nil
}

func (s *portalScreen) keysym(sym uint32, down bool) error {
	state := uint32(0)
	if down {
		state = 1
	}
	return s.notify("NotifyKeyboardKeysym", int32(sym), state)
}

func (s *portalScreen) chord(mods []uint32, key uint32) error {
	pressed := 0
	var failed error
	for _, mod := range mods {
		if failed = s.keysym(mod, true); failed != nil {
			break
		}
		pressed++
	}
	if failed == nil {
		failed = errors.Join(s.keysym(key, true), s.keysym(key, false))
	}
	for i := pressed - 1; i >= 0; i-- {
		failed = errors.Join(failed, s.keysym(mods[i], false))
	}
	return failed
}

func (s *portalScreen) key(keys string) error {
	mods, key, err := chordKeysyms(keys)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.chord(mods, key)
}

func typedByKey(r rune) bool {
	return r == '\n' || r == '\t' || (r >= 0x20 && r <= 0x7e)
}

func (s *portalScreen) typeRunes(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	runes := []rune(text)
	for len(runes) > 0 {
		if typedByKey(runes[0]) {
			if err := s.chord(nil, runeKeysym(runes[0])); err != nil {
				return err
			}
			time.Sleep(5 * time.Millisecond)
			runes = runes[1:]
			continue
		}
		end := 1
		for end < len(runes) && !typedByKey(runes[end]) {
			end++
		}
		if err := s.paste(string(runes[:end])); err != nil {
			return err
		}
		runes = runes[end:]
	}
	return nil
}

func (s *portalScreen) paste(text string) error {
	if err := s.offer(text); err != nil {
		return err
	}
	if err := s.chord([]uint32{modifierKeysyms["ctrl"]}, 'v'); err != nil {
		return err
	}
	time.Sleep(150 * time.Millisecond)
	return nil
}

func (s *portalScreen) offer(text string) error {
	session, err := s.start()
	if err != nil {
		return err
	}
	if !session.clipboard {
		return fmt.Errorf("Wayland: this desktop's portal has no clipboard, so %q cannot be typed (only ASCII can); paste it some other way", text)
	}
	s.pasteMu.Lock()
	s.pasteNow = text
	s.pasteMu.Unlock()
	if err := s.desktop.Call(portalClip+".SetSelection", 0, session.handle, map[string]dbus.Variant{"mime_types": dbus.MakeVariant([]string{plainText, "text/plain", "UTF8_STRING"})}).Err; err != nil {
		return fmt.Errorf("SetSelection: %w", err)
	}
	time.Sleep(100 * time.Millisecond)
	return nil
}

func (s *portalScreen) holdClipboard() (func() error, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.start()
	if err != nil {
		return nil, err
	}
	if !session.clipboard {
		return nil, errors.New("this desktop's portal has no clipboard")
	}
	var fd dbus.UnixFD
	if err := s.desktop.Call(portalClip+".SelectionRead", 0, session.handle, plainText).Store(&fd); err != nil {
		return nil, fmt.Errorf("read the clipboard: %w", err)
	}
	file := os.NewFile(uintptr(fd), "selection")
	saved, err := io.ReadAll(io.LimitReader(file, clipboardLimit+1))
	file.Close()
	if err != nil {
		return nil, err
	}
	if len(saved) > clipboardLimit {
		return nil, errors.New("the clipboard is too large to put back")
	}
	return func() error { return s.putClipboard(string(saved)) }, nil
}

func (s *portalScreen) putClipboard(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.offer(text)
}

func (s *portalScreen) pasteKeys() string { return "ctrl+v" }

func (s *portalScreen) answerPastes(session dbus.ObjectPath) {
	match := []dbus.MatchOption{dbus.WithMatchObjectPath(portalPath), dbus.WithMatchInterface(portalClip), dbus.WithMatchMember("SelectionTransfer")}
	if s.bus.AddMatchSignal(match...) != nil {
		return
	}
	transfers := make(chan *dbus.Signal, 8)
	s.bus.Signal(transfers)
	for signal := range transfers {
		if signal.Name != portalClip+".SelectionTransfer" || len(signal.Body) < 3 {
			continue
		}
		serial, _ := signal.Body[2].(uint32)
		s.pasteMu.Lock()
		text := s.pasteNow
		s.pasteMu.Unlock()
		var fd dbus.UnixFD
		if err := s.desktop.Call(portalClip+".SelectionWrite", 0, session, serial).Store(&fd); err != nil {
			continue
		}
		file := os.NewFile(uintptr(fd), "selection")
		_, err := file.WriteString(text)
		file.Close()
		s.desktop.Call(portalClip+".SelectionWriteDone", 0, session, serial, err == nil)
	}
}
