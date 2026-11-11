package main

import (
	"errors"
	"fmt"
	"image"
	"strings"
	"testing"
	"time"
)

func TestBatchTransitionPause(t *testing.T) {
	for _, key := range []string{"return", "enter", "esc", "escape", "cmd+return", " ENTER "} {
		if got := pauseAfter(step{Action: "key", Keys: key}); got != settle {
			t.Errorf("%q pause = %s, want %s", key, got, settle)
		}
	}
	for _, s := range []step{{Action: "click"}, {Action: "type", Text: "first\nsecond"}, {Action: "key", Keys: "tab"}, {Action: "key", Keys: "down"}, {Action: "key", Keys: "cmd+a"}} {
		if got := pauseAfter(s); got != 60*time.Millisecond {
			t.Errorf("ordinary step %+v pause = %s", s, got)
		}
	}
}

type failingScreen struct {
	calls        []string
	captureError error
}

func (s *failingScreen) apps() map[int]string         { return nil }
func (s *failingScreen) quit([]int)                   {}
func (s *failingScreen) displays() ([]display, error) { return []display{{0, 0, 20, 10}}, nil }
func (s *failingScreen) capture(display) (image.Image, error) {
	s.calls = append(s.calls, "capture")
	if s.captureError != nil {
		return nil, s.captureError
	}
	return image.NewRGBA(image.Rect(0, 0, 20, 10)), nil
}
func (s *failingScreen) state() (string, string, float64, float64) { return "fixture", "test", 0, 0 }
func (s *failingScreen) pointer(float64, float64) error            { return nil }
func (s *failingScreen) button(_ string, down bool, _ int) error {
	if down {
		s.calls = append(s.calls, "click")
	}
	return nil
}
func (s *failingScreen) wheel(int, int) error { return nil }
func (s *failingScreen) press(string, bool) error {
	s.calls = append(s.calls, "key")
	return errors.New("key unavailable")
}
func (s *failingScreen) typeRunes(string) error { s.calls = append(s.calls, "type"); return nil }

func TestComputerBatchFailureReturnsScreenAndStops(t *testing.T) {
	s := &failingScreen{}
	c := &computer{screen: s, seen: &seen{index: 1, origin: display{0, 0, 20, 10}, scale: 1}}
	content, err := c.act([]step{{Action: "click"}, {Action: "key", Keys: "unknown"}, {Action: "type", Text: "must not run"}})
	if err == nil || !strings.Contains(err.Error(), "step 2 (key)") {
		t.Fatalf("error = %v", err)
	}
	if strings.Join(s.calls, ",") != "click,key,capture" {
		t.Fatalf("calls = %v", s.calls)
	}
	if len(content) != 2 {
		t.Fatalf("expected image and context on failure, got %v", content)
	}
	if content[0].(map[string]any)["type"] != "image" {
		t.Fatal("missing failure screenshot")
	}
}

func TestComputerBatchFailurePreservesBothErrors(t *testing.T) {
	captureError := errors.New("screen unavailable")
	s := &failingScreen{captureError: captureError}
	c := &computer{screen: s}
	_, err := c.act([]step{{Action: "key", Keys: "unknown"}})
	if err == nil || !strings.Contains(err.Error(), "key unavailable") || !errors.Is(err, captureError) {
		t.Fatalf("error = %v", err)
	}
}

type twoDisplays struct {
	failingScreen
	clicked [2]float64
}

func (s *twoDisplays) displays() ([]display, error) {
	return []display{{0, 0, 1920, 1080}, {1920, -580, 1080, 1920}}, nil
}
func (s *twoDisplays) capture(d display) (image.Image, error) {
	return image.NewRGBA(image.Rect(0, 0, int(d.w), int(d.h))), nil
}
func (s *twoDisplays) pointer(x, y float64) error {
	s.clicked = [2]float64{x, y}
	return nil
}

func TestClicksLandOnTheDisplayLastSeen(t *testing.T) {
	s := &twoDisplays{}
	c := &computer{screen: s}
	content, err := c.shot(2)
	if err != nil {
		t.Fatal(err)
	}
	if text := content[1].(map[string]any)["text"].(string); !strings.Contains(text, `"display":"2 of 2"`) || !strings.Contains(text, `"size":[720,1280]`) {
		t.Fatalf("screenshot facts = %s", text)
	}
	if _, err := c.act([]step{{Action: "click", X: 10, Y: 5}}); err != nil {
		t.Fatal(err)
	}
	scale := 1920.0 / 1280
	if want := [2]float64{1920 + 10*scale, -580 + 5*scale}; s.clicked != want {
		t.Fatalf("clicked %v, want %v on the second display", s.clicked, want)
	}
	if _, err := c.shot(3); err == nil || !strings.Contains(err.Error(), "has 2") {
		t.Fatalf("a missing display should say how many there are, got %v", err)
	}
}

type keyboard struct {
	failingScreen
	events []string
}

func (s *keyboard) press(key string, down bool) error {
	if down {
		s.events = append(s.events, "key "+key)
	}
	return nil
}
func (s *keyboard) typeRunes(line string) error {
	s.events = append(s.events, "runes "+line)
	return nil
}

type pasting struct {
	keyboard
	holdError, putError, restoreError error
}

func (s *pasting) holdClipboard() (func() error, error) {
	if s.holdError != nil {
		return nil, s.holdError
	}
	s.events = append(s.events, "hold")
	return func() error { s.events = append(s.events, "restore"); return s.restoreError }, nil
}
func (s *pasting) putClipboard(text string) error {
	if s.putError != nil {
		return s.putError
	}
	s.events = append(s.events, "put "+text)
	return nil
}
func (s *pasting) pasteKeys() string { return "ctrl+v" }

func TestTextIsPastedLineByLineAndTheClipboardPutBack(t *testing.T) {
	s := &pasting{}
	if err := (&computer{screen: s}).typeText("中文 ok\r\n\nlast"); err != nil {
		t.Fatal(err)
	}
	want := "hold,put 中文 ok,key ctrl,key v,key return,key return,put last,key ctrl,key v,restore"
	if got := strings.Join(s.events, ","); got != want {
		t.Fatalf("events = %s\nwant     %s", got, want)
	}
}

func TestTextIsTypedKeyByKeyWithoutAClipboard(t *testing.T) {
	busy := &pasting{holdError: errors.New("busy")}
	none := &keyboard{}
	for name, c := range map[string]struct {
		screen screen
		events *[]string
	}{"busy": {busy, &busy.events}, "none": {none, &none.events}} {
		if err := (&computer{screen: c.screen}).typeText("a\nb"); err != nil {
			t.Fatal(err)
		}
		if got := strings.Join(*c.events, ","); got != "runes a,key return,runes b" {
			t.Fatalf("%s: events = %s", name, got)
		}
	}
}

func TestALineTheClipboardRefusesIsTypedAndTheClipboardStillPutBack(t *testing.T) {
	s := &pasting{putError: errors.New("refused")}
	if err := (&computer{screen: s}).typeText("a"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.events, ","); got != "hold,runes a,restore" {
		t.Fatalf("events = %s", got)
	}
}

func TestAClipboardNotPutBackIsReported(t *testing.T) {
	s := &pasting{restoreError: errors.New("locked")}
	err := (&computer{screen: s}).typeText("a")
	if err == nil || !strings.Contains(err.Error(), "clipboard could not be put back") {
		t.Fatalf("error = %v", err)
	}
}

type input struct {
	failingScreen
	events []string
}

func (s *input) pointer(x, y float64) error {
	s.events = append(s.events, fmt.Sprintf("at %g,%g", x, y))
	return nil
}
func (s *input) button(name string, down bool, click int) error {
	s.events = append(s.events, fmt.Sprintf("%s %v %d", name, down, click))
	return nil
}
func (s *input) press(key string, down bool) error {
	if key == "nope" {
		return errors.New("unknown key")
	}
	s.events = append(s.events, fmt.Sprintf("%s %v", key, down))
	return nil
}

func TestADoubleClickNumbersEachClick(t *testing.T) {
	s := &input{}
	if err := (&computer{screen: s}).click(3, 4, "right", 2, nil); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.events, ","); got != "at 3,4,right true 1,right false 1,right true 2,right false 2" {
		t.Fatalf("events = %s", got)
	}
}

func TestADragHoldsTheButtonWhileThePointerMovesInSteps(t *testing.T) {
	s := &input{}
	if err := (&computer{screen: s}).drag(0, 0, 120, 12); err != nil {
		t.Fatal(err)
	}
	if len(s.events) != dragSteps+3 || s.events[1] != "left true 1" || s.events[2] != "at 10,1" || s.events[dragSteps+1] != "at 120,12" || s.events[dragSteps+2] != "left false 1" {
		t.Fatalf("events = %v", s.events)
	}
}

func TestAChordPressesModifiersInOrderAndReleasesThemInReverse(t *testing.T) {
	s := &input{}
	if err := (&computer{screen: s}).key("ctrl+shift+t"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.events, ","); got != "ctrl true,shift true,t true,t false,shift false,ctrl false" {
		t.Fatalf("events = %s", got)
	}
}

func TestAnUnknownKeyLetsGoOfTheModifiers(t *testing.T) {
	s := &input{}
	if err := (&computer{screen: s}).key("ctrl+nope"); err == nil {
		t.Fatal("an unknown key should fail")
	}
	if got := strings.Join(s.events, ","); got != "ctrl true,ctrl false" {
		t.Fatalf("events = %s", got)
	}
}

type timedButtons struct {
	failingScreen
	presses []time.Time
}

func (s *timedButtons) button(_ string, down bool, _ int) error {
	if down {
		s.presses = append(s.presses, time.Now())
	}
	return nil
}

func TestADoubleClickLeavesAGapBetweenPresses(t *testing.T) {
	s := &timedButtons{}
	if err := (&computer{screen: s}).click(1, 1, "left", 2, nil); err != nil {
		t.Fatal(err)
	}
	if len(s.presses) != 2 || s.presses[1].Sub(s.presses[0]) < clickGap {
		t.Fatalf("presses %v: the second press must come at least %s after the first, or GTK on Wayland sees two single clicks", s.presses, clickGap)
	}
}

func TestAPlusKeyAndSpacedChordsAreRead(t *testing.T) {
	for keys, want := range map[string]string{"cmd++": "cmd true,+ true,+ false,cmd false", "ctrl+plus": "ctrl true,+ true,+ false,ctrl false", "+": "+ true,+ false", "cmd+ c": "cmd true,c true,c false,cmd false"} {
		s := &input{}
		if err := (&computer{screen: s}).key(keys); err != nil {
			t.Fatalf("%s: %v", keys, err)
		}
		if got := strings.Join(s.events, ","); got != want {
			t.Errorf("%s: events = %s", keys, got)
		}
	}
	if _, _, err := keyChord("cmd+"); err == nil {
		t.Error("a chord ending in a lone + should name no key")
	}
}

func TestAClickHoldsItsModifiersAroundThePress(t *testing.T) {
	s := &input{}
	c := &computer{screen: s, seen: &seen{index: 1, origin: display{0, 0, 20, 10}, scale: 1}}
	if err := c.run(step{Action: "click", X: 3, Y: 4, Keys: "cmd+shift"}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.events, ","); got != "at 3,4,cmd true,shift true,left true 1,left false 1,shift false,cmd false" {
		t.Fatalf("events = %s", got)
	}
}
