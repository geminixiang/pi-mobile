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
	content, err := c.act([]step{{Action: "click"}, {Action: "key", Keys: "unknown"}, {Action: "type", Text: "must not run"}}, false)
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
	_, err := c.act([]step{{Action: "key", Keys: "unknown"}}, false)
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
	content, err := c.shot(2, false)
	if err != nil {
		t.Fatal(err)
	}
	if text := content[1].(map[string]any)["text"].(string); !strings.Contains(text, `"display":"2 of 2"`) || !strings.Contains(text, `"size":[720,1280]`) {
		t.Fatalf("screenshot facts = %s", text)
	}
	if _, err := c.act([]step{{Action: "click", X: 10, Y: 5}}, false); err != nil {
		t.Fatal(err)
	}
	scale := 1920.0 / 1280
	if want := [2]float64{1920 + 10*scale, -580 + 5*scale}; s.clicked != want {
		t.Fatalf("clicked %v, want %v on the second display", s.clicked, want)
	}
	if _, err := c.shot(3, false); err == nil || !strings.Contains(err.Error(), "has 2") {
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

type readPasting struct {
	pasting
	taken  chan struct{}
	reader bool
}

func (s *readPasting) reads() <-chan struct{} { return s.taken }
func (s *readPasting) press(key string, down bool) error {
	if key == "v" && down && s.reader {
		poke(s.taken)
	}
	return s.pasting.press(key, down)
}

func TestAPasteGoesOnOnceTheAppHasReadIt(t *testing.T) {
	for name, c := range map[string]struct {
		reader     bool
		fast, slow time.Duration
	}{"read": {true, 0, 2 * pasteRead}, "never read": {false, 3 * pasteRead, 4 * pasteRead}} {
		s := &readPasting{taken: make(chan struct{}, 1), reader: c.reader}
		start := time.Now()
		if err := (&computer{screen: s}).typeText("a\nb\nc"); err != nil {
			t.Fatal(err)
		}
		if took := time.Since(start); took < c.fast || took >= c.slow {
			t.Errorf("%s: three lines took %s, want at least %s and under %s", name, took, c.fast, c.slow)
		}
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
	if mods, key, _ := keyChord("Control+Option+Enter"); strings.Join(mods, ",") != "ctrl,alt" || key != "return" {
		t.Errorf("aliases read as %v %q, want ctrl,alt and return", mods, key)
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

type slowField struct {
	keyboard
	opened time.Time
	typed  time.Time
}

func (s *slowField) press(key string, down bool) error {
	if key == "n" && down {
		s.opened = time.Now()
	}
	return s.keyboard.press(key, down)
}
func (s *slowField) typeRunes(line string) error {
	s.typed = time.Now()
	return s.keyboard.typeRunes(line)
}
func (s *slowField) focused() (focus, bool) {
	if s.opened.IsZero() || time.Since(s.opened) < 300*time.Millisecond {
		return focus{role: "list"}, true
	}
	return focus{role: "text field", editable: true}, true
}

func TestTypingWaitsForTheFieldAKeyOpened(t *testing.T) {
	s := &slowField{}
	if _, err := (&computer{screen: s}).act([]step{{Action: "key", Keys: "cmd+shift+n"}, {Action: "type", Text: "封存"}}, false); err != nil {
		t.Fatal(err)
	}
	if waited := s.typed.Sub(s.opened); waited < 300*time.Millisecond {
		t.Fatalf("typed %s after the key, before the field took the focus at 300ms", waited)
	}
}

type changingFocus struct {
	keyboard
	changes []time.Duration
	start   time.Time
}

func (s *changingFocus) focused() (focus, bool) {
	seen := 0
	for _, at := range s.changes {
		if time.Since(s.start) >= at {
			seen++
		}
	}
	return focus{role: fmt.Sprint(seen)}, true
}

func TestTheScreenshotIsTakenOnceTheScreenStopsChanging(t *testing.T) {
	for name, c := range map[string]struct {
		changes  []time.Duration
		min, max time.Duration
	}{
		"settles early":  {[]time.Duration{40 * time.Millisecond}, 100 * time.Millisecond, 300 * time.Millisecond},
		"keeps changing": {[]time.Duration{40 * time.Millisecond, 120 * time.Millisecond, 200 * time.Millisecond}, 280 * time.Millisecond, 520 * time.Millisecond},
		"never changes":  {nil, settle, settle + 100*time.Millisecond},
	} {
		s := &changingFocus{changes: c.changes, start: time.Now()}
		(&computer{screen: s}).settle()
		if took := time.Since(s.start); took < c.min || took > c.max {
			t.Errorf("%s: settled after %s, want between %s and %s", name, took, c.min, c.max)
		}
	}
}

func TestFocusFactsShowTheEndOfTheTextAndHideSecrets(t *testing.T) {
	text := focusFacts(focus{role: "AXTextArea", end: "gamma\n", length: 17, caret: 0})
	if text["end"] != "…gamma\n" || text["caret"] != "at the end" {
		t.Errorf("text facts = %v", text)
	}
	notepad := "alpha BETA gamma\r\r會議改到週四 15:30\rRoom 7B, bring the Q3 deck"
	if got := focusFacts(focus{role: "document", end: notepad, length: len([]rune(notepad)), caret: 0})["end"]; got != "alpha BETA gamma\n\n會議改到週四 15:30\nRoom 7B, bring the Q3 deck" {
		t.Errorf("a blank line Notepad typed showed as %q", got)
	}
	long := strings.Repeat("x", 50) + "\none\ntwo\nthree\nfour"
	if got := focusFacts(focus{role: "document", end: long, length: len(long)})["end"]; got != "…one\ntwo\nthree\nfour" {
		t.Errorf("the last lines of a long text showed as %q", got)
	}
	secret := focusFacts(focus{role: "AXTextField", secret: true, end: "hunter2", length: 7})
	if secret["text"] != "hidden" || secret["end"] != nil {
		t.Errorf("a password field showed %v", secret)
	}
}

type windowScreen struct {
	twoDisplays
	nodes     []uiNode
	activated []bool
}

func (s *windowScreen) window(display) ([]uiNode, bool) { return s.nodes, true }

type pressed struct{ s *windowScreen }

func (p pressed) selects() bool { return true }

func (p pressed) activate(adding bool) error {
	p.s.activated = append(p.s.activated, adding)
	return nil
}

func images(content []any) int {
	count := 0
	for _, part := range content {
		if part.(map[string]any)["type"] == "image" {
			count++
		}
	}
	return count
}

func TestALookIsTextUnlessTheWindowGivesTooLittle(t *testing.T) {
	s := &windowScreen{}
	s.nodes = []uiNode{
		{role: "window", name: "files"},
		{depth: 1, role: "button", name: "Save", x: 300, y: 150, placed: true, focused: true},
		{depth: 1, role: "grid cell", name: "合約.txt", target: pressed{s}},
	}
	c := &computer{screen: s}
	content, err := c.shot(1, false)
	if err != nil {
		t.Fatal(err)
	}
	text := content[len(content)-1].(map[string]any)["text"].(string)
	if images(content) != 0 || !strings.Contains(text, "\n [2] button \"Save\" @200,100 focused\n [3] grid cell \"合約.txt\"") {
		t.Fatalf("a look with a full window = %d images and %s", images(content), text)
	}
	if _, err := c.act([]step{{Action: "click", ID: 2}, {Action: "click", ID: 3, Keys: "ctrl"}}, false); err != nil {
		t.Fatal(err)
	}
	if s.clicked != [2]float64{300, 150} || len(s.activated) != 1 || !s.activated[0] {
		t.Fatalf("clicked %v and activated %v, want the button's center and the cell added to the selection", s.clicked, s.activated)
	}
	if _, err := c.act([]step{{Action: "click", ID: 9}}, false); err == nil || !strings.Contains(err.Error(), "no element [9]") {
		t.Fatalf("an unknown id = %v", err)
	}
	if content, _ := c.shot(1, true); images(content) != 1 {
		t.Fatal("image true gave no image")
	}
	s.nodes = s.nodes[:1]
	if content, _ := c.shot(1, false); images(content) != 1 {
		t.Fatal("a window with one named element gave no image")
	}
}

func TestTheWindowsBehindShowPastALongWindow(t *testing.T) {
	nodes := []uiNode{{role: "window", name: "front"}}
	for range uiLines + 20 {
		nodes = append(nodes, uiNode{depth: 1, role: "link", name: "x"})
	}
	nodes = append(nodes, uiNode{role: "window", name: "files (explorer, behind)"})
	text := uiText(nodes, func(x, y float64) (int, int) { return int(x), int(y) })
	if !strings.Contains(text, "… 21 more\n[172] window \"files (explorer, behind)\"") {
		t.Fatalf("the window behind is cut off:\n%s", text[len(text)-200:])
	}
}
