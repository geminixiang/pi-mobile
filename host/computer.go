// pi-mobile mcp computer: an MCP server on stdio (newline-delimited JSON-RPC) that lets the phone's model see and use
// this computer's screen, started by the phone through /exec (computer://<address>?command=pi-mobile mcp computer).
//
// Two tools, from the evaluation of computer-use-mcp (docs/research/computer-use-mcp-eval.md):
//   - screenshot: the screen as a small JPEG, with the front app, its window title, and the pointer as text;
//   - act: several mouse and keyboard steps in one call, answered with the screenshot after them, so a step and seeing
//     its result take one model call instead of two.
//
// The screen and input are per system (computer_darwin.go); coordinates are always the screenshot's pixels.
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"strings"
	"time"

	"golang.org/x/image/draw"
)

// The screenshot's longer side: legible text in about a thousand image tokens.
const shotLongSide = 1280

// A settled screen after the last step: menus, sheets, and new windows take a moment to appear.
const settle = 400 * time.Millisecond

// screen is what each system provides.
type screen interface {
	// capture is the main display as an image, and its size in the units input takes (points on macOS).
	capture() (image.Image, float64, float64, error)
	state() (app, window string, x, y float64)
	click(x, y float64, button string, count int) error
	move(x, y float64) error
	drag(x, y, toX, toY float64) error
	scroll(x, y float64, dx, dy int) error
	key(keys string) error
	typeText(text string) error
}

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

type computer struct {
	screen screen
	// From screenshot pixels to input units, as of the last screenshot.
	scale float64
}

func (c *computer) shot() ([]any, error) {
	img, width, _, err := c.screen.capture()
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
	c.scale = width / float64(w)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 70}); err != nil {
		return nil, err
	}
	app, window, x, y := c.screen.state()
	facts := map[string]any{"size": []int{w, h}, "pointer": []int{int(x / c.scale), int(y / c.scale)}}
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

func (c *computer) run(s step) error {
	if c.scale == 0 && s.Action != "key" && s.Action != "type" && s.Action != "wait" {
		return errors.New("take a screenshot first: coordinates are its pixels")
	}
	x, y := s.X*c.scale, s.Y*c.scale
	switch s.Action {
	case "click":
		button := s.Button
		if button == "" {
			button = "left"
		}
		return c.screen.click(x, y, button, max(s.Count, 1))
	case "move":
		return c.screen.move(x, y)
	case "drag":
		return c.screen.drag(x, y, s.ToX*c.scale, s.ToY*c.scale)
	case "scroll":
		return c.screen.scroll(x, y, s.DX, s.DY)
	case "key":
		return c.screen.key(s.Keys)
	case "type":
		return c.screen.typeText(s.Text)
	case "wait":
		time.Sleep(time.Duration(min(max(s.MS, 0), 10000)) * time.Millisecond)
		return nil
	}
	return fmt.Errorf("unknown action %q", s.Action)
}

func (c *computer) act(steps []step) ([]any, error) {
	for i, s := range steps {
		if err := c.run(s); err != nil {
			return nil, fmt.Errorf("step %d (%s): %w; the steps before it were done", i+1, s.Action, err)
		}
		// Let each step land before the next: a click focuses a field before typing goes to it.
		time.Sleep(60 * time.Millisecond)
	}
	time.Sleep(settle)
	return c.shot()
}

var computerTools = []map[string]any{
	{
		"name":        "screenshot",
		"description": "See the computer's screen now: a JPEG of the main display, and as text its size, the front app, the title of its focused window, and the pointer. Coordinates everywhere are this screenshot's pixels.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		"annotations": map[string]any{"title": "Screenshot", "readOnlyHint": true},
	},
	{
		"name": "act",
		"description": "Use the mouse and keyboard, then see the result: runs the steps in order and returns the screenshot after them, as screenshot does. " +
			"Put the steps you can already tell in one call (click a field, type, press return); prefer keys to clicks. " +
			"Steps: click {x, y, button: left (default), right, or middle; count: 2 for a double click}; move {x, y}; drag {x, y, to_x, to_y}; " +
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

// serveComputerMCP answers MCP requests on stdin until it closes.
func serveComputerMCP() int {
	s, err := newScreen()
	if err != nil {
		fmt.Fprintln(os.Stderr, "pi-mobile mcp computer:", err)
		return 1
	}
	c := &computer{screen: s}
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
			continue // notifications and responses need no answer
		}
		switch m.Method {
		case "initialize":
			var p struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(m.Params, &p)
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
					Steps []step `json:"steps"`
				} `json:"arguments"`
			}
			if json.Unmarshal(m.Params, &p) != nil {
				fail(m.ID, -32602, "invalid params")
				continue
			}
			var content []any
			var err error
			switch p.Name {
			case "screenshot":
				content, err = c.shot()
			case "act":
				content, err = c.act(p.Arguments.Steps)
			default:
				err = fmt.Errorf("no tool %q", p.Name)
			}
			if err != nil {
				reply(m.ID, map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": err.Error()}}})
				continue
			}
			reply(m.ID, map[string]any{"content": content})
		default:
			fail(m.ID, -32601, "method not found: "+m.Method)
		}
	}
	return 0
}

// keyChord splits "cmd+shift+t" into its modifiers and the key, lower-cased.
func keyChord(keys string) (mods []string, key string, err error) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(keys)), "+")
	if len(parts) == 0 || parts[len(parts)-1] == "" {
		return nil, "", fmt.Errorf("no key in %q", keys)
	}
	return parts[:len(parts)-1], parts[len(parts)-1], nil
}
