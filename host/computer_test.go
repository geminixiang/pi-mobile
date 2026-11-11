package main

import (
	"errors"
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
func (s *failingScreen) click(float64, float64, string, int) error {
	s.calls = append(s.calls, "click")
	return nil
}
func (s *failingScreen) move(float64, float64) error                   { return nil }
func (s *failingScreen) drag(float64, float64, float64, float64) error { return nil }
func (s *failingScreen) scroll(float64, float64, int, int) error       { return nil }
func (s *failingScreen) key(string) error {
	s.calls = append(s.calls, "key")
	return errors.New("key unavailable")
}
func (s *failingScreen) typeText(string) error { s.calls = append(s.calls, "type"); return nil }

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
func (s *twoDisplays) click(x, y float64, _ string, _ int) error {
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
