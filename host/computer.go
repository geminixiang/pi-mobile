package main

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/image/draw"
)

const shotLongSide = 1280

const settle = 400 * time.Millisecond

const sessionIdle = 2 * time.Minute

type display struct{ x, y, w, h float64 }

type screen interface {
	apps() map[int]string
	quit(pids []int)
	displays() ([]display, error)
	capture(d display) (image.Image, error)
	state() (app, window string, x, y float64)
	pointer(x, y float64) error
	button(name string, down bool, click int) error
	wheel(dx, dy int) error
	press(key string, down bool) error
	typeRunes(line string) error
}

const (
	clickAim  = 30 * time.Millisecond
	clickGap  = 60 * time.Millisecond
	dragSteps = 12
	dragStep  = 15 * time.Millisecond
	chordHold = 30 * time.Millisecond
)

type clipboard interface {
	holdClipboard() (restore func() error, err error)
	putClipboard(text string) error
	pasteKeys() string
}

const pasteRead = 250 * time.Millisecond

type step struct {
	Action string  `json:"action"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	ToX    float64 `json:"to_x"`
	ToY    float64 `json:"to_y"`
	Button string  `json:"button"`
	Count  int     `json:"count"`
	DX     int     `json:"dx"`
	DY     int     `json:"dy"`
	Keys   string  `json:"keys"`
	Text   string  `json:"text"`
	MS     int     `json:"ms"`
}

type seen struct {
	index  int
	origin display
	scale  float64
}

type computer struct {
	screen screen
	seen   *seen

	mu     sync.Mutex
	before map[int]string
	opened map[int]string
	idle   *time.Timer
}

func (c *computer) touch() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.before == nil {
		c.before = c.screen.apps()
		c.opened = map[int]string{}
	}
	if c.idle == nil {
		c.idle = time.AfterFunc(sessionIdle, c.end)
	} else {
		c.idle.Reset(sessionIdle)
	}
}

func (c *computer) noteOpened() {
	now := c.screen.apps()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.before == nil {
		return
	}
	for pid, name := range now {
		if _, was := c.before[pid]; !was {
			c.opened[pid] = name
		}
	}
}

func (c *computer) end() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.before == nil {
		return
	}
	running := c.screen.apps()
	var pids []int
	for pid, name := range c.opened {
		if running[pid] == name {
			pids = append(pids, pid)
		}
	}
	c.screen.quit(pids)
	c.before, c.opened = nil, nil
	c.idle.Stop()
	c.idle = nil
}

func (c *computer) shot(index int) ([]any, error) {
	all, err := c.screen.displays()
	if err != nil {
		return nil, err
	}
	if index < 1 || index > len(all) {
		return nil, fmt.Errorf("no display %d: this computer has %d", index, len(all))
	}
	d := all[index-1]
	img, err := c.screen.capture(d)
	if err != nil {
		return nil, err
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if long := max(w, h); long > shotLongSide {
		w, h = w*shotLongSide/long, h*shotLongSide/long
		small := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.ApproxBiLinear.Scale(small, small.Bounds(), img, bounds, draw.Src, nil)
		img = small
	}
	c.seen = &seen{index: index, origin: d, scale: d.w / float64(w)}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 70}); err != nil {
		return nil, err
	}
	app, window, x, y := c.screen.state()
	facts := map[string]any{"size": []int{w, h}, "pointer": []int{int((x - d.x) / c.seen.scale), int((y - d.y) / c.seen.scale)}}
	if len(all) > 1 {
		facts["display"] = fmt.Sprintf("%d of %d", index, len(all))
	}
	if app != "" {
		facts["app"] = app
	}
	if window != "" {
		facts["window"] = window
	}
	text, _ := json.Marshal(facts)
	return []any{
		map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(out.Bytes()), "mimeType": "image/jpeg"},
		map[string]any{"type": "text", "text": string(text)},
	}, nil
}

func (c *computer) lastDisplay() int {
	if c.seen == nil {
		return 1
	}
	return c.seen.index
}

func (c *computer) run(s step) error {
	switch s.Action {
	case "key":
		return c.key(s.Keys)
	case "type":
		return c.typeText(s.Text)
	case "wait":
		time.Sleep(time.Duration(min(max(s.MS, 0), 10000)) * time.Millisecond)
		return nil
	}
	if c.seen == nil {
		return errors.New("take a screenshot first: coordinates are its pixels")
	}
	at := func(x, y float64) (float64, float64) {
		return c.seen.origin.x + x*c.seen.scale, c.seen.origin.y + y*c.seen.scale
	}
	x, y := at(s.X, s.Y)
	switch s.Action {
	case "click":
		button := s.Button
		if button == "" {
			button = "left"
		}
		return c.click(x, y, button, max(s.Count, 1), heldKeys(s.Keys))
	case "move":
		return c.screen.pointer(x, y)
	case "drag":
		toX, toY := at(s.ToX, s.ToY)
		return c.drag(x, y, toX, toY)
	case "scroll":
		if err := c.screen.pointer(x, y); err != nil {
			return err
		}
		return c.screen.wheel(s.DX, s.DY)
	}
	return fmt.Errorf("unknown action %q", s.Action)
}

func (c *computer) click(x, y float64, button string, count int, mods []string) error {
	if err := c.screen.pointer(x, y); err != nil {
		return err
	}
	time.Sleep(clickAim)
	return c.holding(mods, func() error { return c.clicks(button, count) })
}

func (c *computer) clicks(button string, count int) error {
	for i := 1; i <= count; i++ {
		if i > 1 {
			// why: on Wayland the app counts a double click from the gap between presses; GTK took two presses sent back to back as two single clicks
			time.Sleep(clickGap)
		}
		if err := c.screen.button(button, true, i); err != nil {
			return err
		}
		if err := c.screen.button(button, false, i); err != nil {
			return err
		}
	}
	return nil
}

func (c *computer) drag(x, y, toX, toY float64) error {
	if err := c.screen.pointer(x, y); err != nil {
		return err
	}
	if err := c.screen.button("left", true, 1); err != nil {
		return err
	}
	for i := 1; i <= dragSteps; i++ {
		time.Sleep(dragStep)
		if err := c.screen.pointer(x+(toX-x)*float64(i)/dragSteps, y+(toY-y)*float64(i)/dragSteps); err != nil {
			return errors.Join(err, c.screen.button("left", false, 1))
		}
	}
	return c.screen.button("left", false, 1)
}

func (c *computer) key(keys string) error {
	mods, name, err := keyChord(keys)
	if err != nil {
		return err
	}
	return c.holding(mods, func() error {
		if err := c.screen.press(name, true); err != nil {
			return err
		}
		return c.screen.press(name, false)
	})
}

func (c *computer) holding(mods []string, act func() error) error {
	held := []string{}
	release := func() error {
		var errs []error
		for i := len(held) - 1; i >= 0; i-- {
			errs = append(errs, c.screen.press(held[i], false))
		}
		return errors.Join(errs...)
	}
	for _, mod := range mods {
		if err := c.screen.press(mod, true); err != nil {
			return errors.Join(err, release())
		}
		held = append(held, mod)
	}
	if len(held) > 0 {
		// why: WinUI apps such as Notepad check whether ctrl is down when they handle the key, not when it was sent; a chord sent at once pasted a bare "v" or nothing
		time.Sleep(chordHold)
	}
	acted := act()
	if len(held) > 0 {
		time.Sleep(chordHold)
	}
	return errors.Join(acted, release())
}

func (c *computer) typeText(text string) error {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	board, ok := c.screen.(clipboard)
	if !ok {
		return c.typeLines(lines, nil)
	}
	restore, err := board.holdClipboard()
	if err != nil {
		return c.typeLines(lines, nil)
	}
	typed := c.typeLines(lines, board)
	if err := restore(); err != nil {
		return errors.Join(typed, fmt.Errorf("the text went in, but the clipboard could not be put back: %w", err))
	}
	return typed
}

func (c *computer) typeLines(lines []string, board clipboard) error {
	for i, line := range lines {
		if i > 0 {
			if err := c.key("return"); err != nil {
				return err
			}
		}
		if line == "" {
			continue
		}
		if board == nil || board.putClipboard(line) != nil {
			if err := c.screen.typeRunes(line); err != nil {
				return err
			}
			continue
		}
		if err := c.key(board.pasteKeys()); err != nil {
			return err
		}
		// why: the app reads the clipboard after the paste keys arrive, so the next line or the restored clipboard must wait for it
		time.Sleep(pasteRead)
	}
	return nil
}

func pauseAfter(s step) time.Duration {
	if s.Action == "key" {
		_, key, err := keyChord(s.Keys)
		if err == nil {
			switch key {
			case "return", "enter", "esc", "escape":
				return settle
			}
		}
	}
	return 60 * time.Millisecond
}

func (c *computer) act(steps []step) ([]any, error) {
	for i, s := range steps {
		if err := c.run(s); err != nil {
			failure := fmt.Errorf("step %d (%s): %w; earlier steps were done, later steps were not run", i+1, s.Action, err)
			content, captureError := c.shot(c.lastDisplay())
			if captureError != nil {
				return content, errors.Join(failure, fmt.Errorf("failure screenshot: %w", captureError))
			}
			return content, failure
		}
		if i+1 < len(steps) {
			time.Sleep(pauseAfter(s))
		}
	}
	time.Sleep(settle)
	return c.shot(c.lastDisplay())
}

var computerTools = []map[string]any{
	{
		"name":        "screenshot",
		"description": "See the computer's screen now: a JPEG of one display (the main one unless display says another), and as text its size, the front app, the title of its focused window, the pointer, and which display of how many when there are several. Coordinates everywhere are this screenshot's pixels, on its display, until the next screenshot. Apps opened while using the screen are quit two minutes after the last use.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"display": map[string]any{"type": "integer", "description": "1 is the main display (default), 2 and up the others"}}},
		"annotations": map[string]any{"title": "Screenshot", "readOnlyHint": true},
	},
	{
		"name": "act",
		"description": "Use the mouse and keyboard, then see the result: runs the steps in order and returns the screenshot after them, as screenshot does. " +
			"Put the steps you can already tell in one call (click a field, type, press return); prefer keys to clicks. " +
			"Steps: click {x, y, button: left (default), right, or middle; count: 2 for a double click; keys: modifiers held during it, such as \"cmd\" or \"shift\"}; move {x, y}; drag {x, y, to_x, to_y}; " +
			"scroll {x, y, dy and dx in lines, positive down and right}; key {keys: such as \"cmd+shift+t\", \"return\", \"esc\", \"down\"}; type {text}; wait {ms}.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"steps": map[string]any{
					"type": "array",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"action": map[string]any{"type": "string", "enum": []string{"click", "move", "drag", "scroll", "key", "type", "wait"}},
							"x":      map[string]any{"type": "number"}, "y": map[string]any{"type": "number"},
							"to_x": map[string]any{"type": "number"}, "to_y": map[string]any{"type": "number"},
							"button": map[string]any{"type": "string", "enum": []string{"left", "right", "middle"}},
							"count":  map[string]any{"type": "integer"},
							"dx":     map[string]any{"type": "integer"}, "dy": map[string]any{"type": "integer"},
							"keys": map[string]any{"type": "string"}, "text": map[string]any{"type": "string"},
							"ms": map[string]any{"type": "integer"},
						},
						"required": []string{"action"},
					},
				},
			},
			"required": []string{"steps"},
		},
		"annotations": map[string]any{"title": "Mouse and keyboard"},
	},
}

type rpcMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

func serveComputerMCP() int {
	s, err := newScreen()
	if err != nil {
		fmt.Fprintln(os.Stderr, "pi-mobile mcp computer:", err)
		return 1
	}
	c := &computer{screen: s}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		<-stop
		c.end()
		os.Exit(0)
	}()
	defer c.end()
	out := json.NewEncoder(os.Stdout)
	reply := func(id json.RawMessage, result any) {
		_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	fail := func(id json.RawMessage, code int, message string) {
		_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 16<<20)
	for in.Scan() {
		var m rpcMessage
		if json.Unmarshal(in.Bytes(), &m) != nil || len(m.ID) == 0 {
			continue
		}
		switch m.Method {
		case "initialize":
			var p struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			if err := json.Unmarshal(m.Params, &p); err != nil {
				fail(m.ID, -32602, "invalid initialize params: "+err.Error())
				continue
			}
			reply(m.ID, map[string]any{
				"protocolVersion": p.ProtocolVersion,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "pi-mobile computer", "version": version},
			})
		case "ping":
			reply(m.ID, map[string]any{})
		case "tools/list":
			reply(m.ID, map[string]any{"tools": computerTools})
		case "tools/call":
			var p struct {
				Name      string `json:"name"`
				Arguments struct {
					Steps   []step `json:"steps"`
					Display int    `json:"display"`
				} `json:"arguments"`
			}
			if json.Unmarshal(m.Params, &p) != nil {
				fail(m.ID, -32602, "invalid params")
				continue
			}
			var content []any
			var err error
			c.touch()
			switch p.Name {
			case "screenshot":
				content, err = c.shot(cmp.Or(p.Arguments.Display, 1))
			case "act":
				content, err = c.act(p.Arguments.Steps)
			default:
				err = fmt.Errorf("no tool %q", p.Name)
			}
			c.noteOpened()
			if err != nil {
				content = append([]any{map[string]any{"type": "text", "text": err.Error()}}, content...)
				reply(m.ID, map[string]any{"isError": true, "content": content})
				continue
			}
			reply(m.ID, map[string]any{"content": content})
		default:
			fail(m.ID, -32601, "method not found: "+m.Method)
		}
	}
	return 0
}

func keyChord(keys string) (mods []string, key string, err error) {
	chord := strings.ToLower(strings.TrimSpace(keys))
	if chord == "+" || strings.HasSuffix(chord, "++") {
		return heldKeys(strings.TrimSuffix(chord, "++")), "+", nil
	}
	parts := heldKeys(chord)
	if len(parts) == 0 || strings.HasSuffix(chord, "+") {
		return nil, "", fmt.Errorf("no key in %q", keys)
	}
	key = parts[len(parts)-1]
	if key == "plus" {
		key = "+"
	}
	return parts[:len(parts)-1], key, nil
}

func heldKeys(keys string) []string {
	var names []string
	for _, part := range strings.Split(strings.ToLower(keys), "+") {
		if name := strings.TrimSpace(part); name != "" {
			names = append(names, name)
		}
	}
	return names
}
