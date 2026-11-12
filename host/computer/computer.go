package computer

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
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/image/draw"
)

const shotLongSide = 1024

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

type focus struct {
	role, window, end, selected string
	length, caret               int
	editable, secret            bool
}

type focusReader interface {
	focused() (focus, bool)
}

const (
	focusTail  = 40
	focusLines = 4
	focusRead  = focusTail * focusLines
	focusPoll  = 15 * time.Millisecond
	focusQuiet = 100 * time.Millisecond
	typeReady  = time.Second
)

type uiNode struct {
	depth                                int
	role, name                           string
	x, y                                 float64
	placed                               bool
	focused, selected, disabled, checked bool
	target                               uiTarget
	id, more                             int
}

type uiOther struct {
	title, app string
	target     uiTarget
}

type uiView struct {
	window []uiNode
	others []uiOther
}

type uiTarget interface {
	activate(adding bool) error
	selects() bool
}

type uiWriter interface {
	write(text string) error
}

type uiOpener interface {
	open() error
}

type uiCloser interface {
	close()
}

type uiReader interface {
	window(on display, title string) uiView
}

const (
	uiLines  = 150
	uiName   = 80
	uiThin   = 3
	uiWalk   = 800
	uiOthers = 8
	uiRun    = 25
	uiPoll   = 150 * time.Millisecond
	uiDepth  = 30
)

type pasteReads interface {
	reads() <-chan struct{}
}

func poke(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

func drain(c chan struct{}) {
	select {
	case <-c:
	default:
	}
}

type step struct {
	Action string  `json:"action"`
	ID     int     `json:"id"`
	Name   string  `json:"name"`
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
	ui     []uiNode
	window bool
	lines  []uiLine
}

type computer struct {
	screen screen
	seen   *seen

	mu      sync.Mutex
	session *session

	ids    map[string]int
	lastID int
	held   []uiCloser
	watch  string
}

type session struct {
	before, opened map[int]string
	idle           *time.Timer
}

func (c *computer) touch() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.session != nil {
		c.session.idle.Reset(sessionIdle)
		return
	}
	c.session = &session{before: c.screen.apps(), opened: map[int]string{}, idle: time.AfterFunc(sessionIdle, c.end)}
}

func (c *computer) noteOpened() {
	now := c.screen.apps()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.session == nil {
		return
	}
	for pid, name := range now {
		if _, was := c.session.before[pid]; !was {
			c.session.opened[pid] = name
		}
	}
}

func (c *computer) end() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.session == nil {
		return
	}
	running := c.screen.apps()
	var pids []int
	for pid, name := range c.session.opened {
		if running[pid] == name {
			pids = append(pids, pid)
		}
	}
	c.screen.quit(pids)
	c.session.idle.Stop()
	c.session = nil
}

func (c *computer) shot(index int, picture bool) ([]any, error) {
	return c.look(index, picture, false)
}

func (c *computer) look(index int, picture, changes bool) ([]any, error) {
	all, err := c.screen.displays()
	if err != nil {
		return nil, err
	}
	if index < 1 || index > len(all) {
		return nil, fmt.Errorf("no display %d: this computer has %d", index, len(all))
	}
	d := all[index-1]
	type state struct {
		app, window string
		x, y        float64
		focus       focus
		ui          []uiNode
		read        bool
	}
	now := func() state {
		app, window, x, y := c.screen.state()
		now := state{app: app, window: window, x: x, y: y}
		if reader, ok := c.screen.(focusReader); ok {
			now.focus, _ = reader.focused()
		}
		if reader, ok := c.screen.(uiReader); ok {
			now.ui, now.read = c.observe(reader, d)
		}
		return now
	}()
	w, h := shotSize(d)
	var before []uiLine
	if c.seen != nil && c.seen.index == index {
		before = c.seen.lines
	}
	c.seen = &seen{index: index, origin: d, scale: d.w / float64(w), ui: now.ui, window: now.read}
	var content []any
	if picture || !now.read || named(now.ui) < uiThin {
		jpg, err := c.picture(d, w, h)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(jpg), "mimeType": "image/jpeg"})
	}
	toShot := func(x, y float64) (int, int) { return int((x - d.x) / c.seen.scale), int((y - d.y) / c.seen.scale) }
	px, py := toShot(now.x, now.y)
	facts := map[string]any{"size": []int{w, h}, "pointer": []int{px, py}}
	if len(all) > 1 {
		facts["display"] = fmt.Sprintf("%d of %d", index, len(all))
	}
	if now.app != "" {
		facts["app"] = now.app
	}
	if now.window != "" {
		facts["window"] = now.window
	}
	if now.focus.role != "" && (!now.read || now.ui[0].name == now.window) {
		facts["focus"] = focusFacts(now.focus)
	}
	text, _ := json.Marshal(facts)
	said := string(text)
	if now.read {
		c.seen.lines = render(now.ui, toShot)
		said += "\n" + changed(before, c.seen.lines, changes)
	}
	return append(content, map[string]any{"type": "text", "text": said}), nil
}

func untagged(title string) string {
	if i := strings.LastIndex(title, " ("); i >= 0 && strings.HasSuffix(title, ", behind)") {
		return title[:i]
	}
	return title
}

func shotSize(d display) (int, int) {
	w, h := int(d.w), int(d.h)
	if long := max(w, h); long > shotLongSide {
		return w * shotLongSide / long, h * shotLongSide / long
	}
	return w, h
}

func (c *computer) picture(d display, w, h int) ([]byte, error) {
	img, err := c.screen.capture(d)
	if err != nil {
		return nil, err
	}
	if bounds := img.Bounds(); bounds.Dx() != w || bounds.Dy() != h {
		small := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.ApproxBiLinear.Scale(small, small.Bounds(), img, bounds, draw.Src, nil)
		img = small
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 70}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func tidy(nodes []uiNode) []uiNode {
	type kept struct {
		depth, children int
		name            string
	}
	var out []uiNode
	var stack []kept
	for i, n := range nodes {
		for len(stack) > 0 && stack[len(stack)-1].depth >= n.depth {
			stack = stack[:len(stack)-1]
		}
		n.name = strings.Trim(strings.Map(visible, n.name), " \t")
		depth, above := 0, ""
		if len(stack) > 0 {
			depth, above = stack[len(stack)-1].children, stack[len(stack)-1].name
		}
		parent := i+1 < len(nodes) && nodes[i+1].depth > n.depth
		drop := n.depth > 0 && ((n.name == "" && parent) || (n.name != "" && n.name == above) || (n.disabled && !parent))
		if drop {
			stack = append(stack, kept{n.depth, depth, above})
			continue
		}
		stack = append(stack, kept{n.depth, depth + 1, n.name})
		n.depth = depth
		out = append(out, n)
	}
	return crowd(out)
}

// why: a folder column in a save panel lists every file in it, and hundreds of rows pushed the panel's name field and buttons past the line limit
func crowd(nodes []uiNode) []uiNode {
	var out []uiNode
	run := 0
	for i, n := range nodes {
		leaf := i+1 == len(nodes) || nodes[i+1].depth <= n.depth
		same := len(out) > 0 && leaf && out[len(out)-1].depth == n.depth && out[len(out)-1].role == n.role && n.depth > 0
		if !same {
			run = 0
		}
		run++
		if run > uiRun {
			out[len(out)-1].more++
			continue
		}
		out = append(out, n)
	}
	return out
}

func visible(r rune) rune {
	switch r {
	case '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\ufeff':
		return -1
	}
	return r
}

func named(nodes []uiNode) int {
	count := 0
	for i, n := range nodes {
		if i > 0 && n.depth == 0 {
			break
		}
		if n.name != "" {
			count++
		}
	}
	return count
}

func uiText(nodes []uiNode, toShot func(x, y float64) (int, int)) string {
	return changed(nil, render(nodes, toShot), false)
}

type uiLine struct {
	id   int
	text string
}

func changed(before, now []uiLine, changes bool) string {
	if !changes || len(before) == 0 || len(now) == 0 || before[0] != now[0] {
		return "ui:\n" + joinLines(now)
	}
	was := map[int]string{}
	for _, line := range before {
		was[line.id] = line.text
	}
	var lines []uiLine
	here := map[int]bool{}
	for _, line := range now {
		here[line.id] = true
		if text, ok := was[line.id]; !ok || text != line.text {
			lines = append(lines, line)
		}
	}
	var gone []string
	for _, line := range before {
		if line.id != 0 && !here[line.id] {
			gone = append(gone, fmt.Sprintf("[%d]", line.id))
		}
	}
	if len(lines) == 0 && len(gone) == 0 {
		return "ui: nothing changed since the last look"
	}
	said := "ui, only what changed since the last look (other elements are as they were, same ids):"
	if len(lines) > 0 {
		said += "\n" + joinLines(lines)
	}
	if len(gone) > 0 {
		said += "\ngone: " + strings.Join(gone, " ")
	}
	return said
}

func joinLines(lines []uiLine) string {
	texts := make([]string, len(lines))
	for i, line := range lines {
		texts[i] = line.text
	}
	return strings.Join(texts, "\n")
}

func (c *computer) number(nodes []uiNode) {
	if c.ids == nil {
		c.ids = map[string]int{}
	}
	seen := map[string]int{}
	for i := range nodes {
		n := &nodes[i]
		key := strings.Join([]string{strconv.Itoa(n.depth), n.role, n.name}, "\x1f")
		seen[key]++
		key += "\x1f" + strconv.Itoa(seen[key])
		if c.ids[key] == 0 {
			c.lastID++
			c.ids[key] = c.lastID
		}
		n.id = c.ids[key]
	}
}

func render(nodes []uiNode, toShot func(x, y float64) (int, int)) []uiLine {
	var lines []uiLine
	others := len(nodes)
	for i, n := range nodes {
		if i > 0 && n.depth == 0 {
			others = i
			break
		}
	}
	for i, n := range nodes {
		if i >= uiLines && i < others {
			if i == uiLines {
				lines = append(lines, uiLine{text: fmt.Sprintf("… %d more", others-uiLines)})
			}
			continue
		}
		id := cmp.Or(n.id, i+1)
		line := fmt.Sprintf("%s[%d] %s", strings.Repeat(" ", n.depth), id, n.role)
		if n.name != "" {
			line += " " + strconv.Quote(clip(n.name, uiName))
		}
		if leaf := i+1 == len(nodes) || nodes[i+1].depth <= n.depth; n.placed && leaf {
			x, y := toShot(n.x, n.y)
			line += fmt.Sprintf(" @%d,%d", x, y)
		}
		for _, flag := range []struct {
			on   bool
			name string
		}{{n.focused, "focused"}, {n.selected, "selected"}, {n.checked, "on"}, {n.disabled, "disabled"}} {
			if flag.on {
				line += " " + flag.name
			}
		}
		lines = append(lines, uiLine{id, line})
		if n.more > 0 {
			lines = append(lines, uiLine{text: fmt.Sprintf("%s… %d more %s", strings.Repeat(" ", n.depth), n.more, n.role)})
		}
	}
	return lines
}

func clip(s string, limit int) string {
	if runes := []rune(s); len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return s
}

func focusFacts(f focus) map[string]any {
	facts := map[string]any{"role": f.role}
	if f.secret {
		facts["text"] = "hidden"
		return facts
	}
	if f.length == 0 {
		return facts
	}
	facts["end"] = lastLines(f.end, f.length > len([]rune(f.end)))
	if f.selected != "" {
		facts["selected"] = f.selected
	}
	switch {
	case f.caret == 0:
		facts["caret"] = "at the end"
	case f.caret > 0:
		facts["caret"] = fmt.Sprintf("%d characters before the end", f.caret)
	}
	return facts
}

func lastLines(end string, cut bool) string {
	// why: UI Automation ends Notepad's lines with a bare \r
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(end, "\r\n", "\n"), "\r", "\n"), "\n")
	if len(lines) > focusLines {
		lines, cut = lines[len(lines)-focusLines:], true
	}
	for i, line := range lines {
		if runes := []rune(line); len(runes) > focusTail {
			lines[i] = "…" + string(runes[len(runes)-focusTail:])
			continue
		}
		if i == 0 && cut {
			lines[i] = "…" + line
		}
	}
	return strings.Join(lines, "\n")
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
		n, targeted, err := c.element(s)
		if err != nil {
			return err
		}
		if !targeted {
			return c.typeText(s.Text)
		}
		if writer, ok := n.target.(uiWriter); ok && writer.write(s.Text) == nil {
			return nil
		}
		if err := c.clickNode(n, step{Action: "click"}); err != nil {
			return err
		}
		if err := c.front(step{Action: "type"}); err != nil {
			return err
		}
		return c.typeText(s.Text)
	case "wait":
		if s.Name != "" {
			_, err := c.find(s.Name, time.Duration(cmp.Or(min(max(s.MS, 0), 10000), 3000))*time.Millisecond)
			return err
		}
		time.Sleep(time.Duration(min(max(s.MS, 0), 10000)) * time.Millisecond)
		return nil
	}
	if c.seen == nil {
		return errors.New("take a screenshot first: coordinates are its pixels")
	}
	if s.Action == "click" && s.Name != "" {
		n, err := c.find(s.Name, 0)
		if err != nil {
			return err
		}
		return c.clickNode(n, s)
	}
	if s.Action == "click" && s.ID != 0 {
		i := slices.IndexFunc(c.seen.ui, func(n uiNode) bool { return n.id == s.ID })
		if i < 0 {
			return fmt.Errorf("no element [%d] in the last look", s.ID)
		}
		return c.clickNode(c.seen.ui[i], s)
	}
	at := func(x, y float64) (float64, float64) {
		return c.seen.origin.x + x*c.seen.scale, c.seen.origin.y + y*c.seen.scale
	}
	x, y := at(s.X, s.Y)
	switch s.Action {
	case "click":
		return c.click(x, y, cmp.Or(s.Button, "left"), max(s.Count, 1), heldKeys(s.Keys))
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

func (c *computer) observe(reader uiReader, on display) ([]uiNode, bool) {
	view := reader.window(on, c.watch)
	if c.watch != "" && (len(view.window) == 0 || view.window[0].name != c.watch) {
		c.watch = ""
		view = reader.window(on, "")
	}
	c.hold(view)
	nodes := tidy(view.window)
	read := len(nodes) > 0
	for _, other := range view.others {
		nodes = append(nodes, uiNode{role: "window", name: other.title + " (" + other.app + ", behind)", target: other.target})
	}
	c.number(nodes)
	return nodes, read
}

func (c *computer) hold(view uiView) {
	for _, held := range c.held {
		held.close()
	}
	c.held = nil
	targets := make([]uiTarget, 0, len(view.window)+len(view.others))
	for _, n := range view.window {
		targets = append(targets, n.target)
	}
	for _, other := range view.others {
		targets = append(targets, other.target)
	}
	for _, target := range targets {
		if closer, ok := target.(uiCloser); ok {
			c.held = append(c.held, closer)
		}
	}
}

func (c *computer) element(s step) (uiNode, bool, error) {
	if s.Name != "" {
		n, err := c.find(s.Name, 0)
		return n, true, err
	}
	if s.ID == 0 || c.seen == nil {
		return uiNode{}, false, nil
	}
	i := slices.IndexFunc(c.seen.ui, func(n uiNode) bool { return n.id == s.ID })
	if i < 0 {
		return uiNode{}, true, fmt.Errorf("no element [%d] in the last look", s.ID)
	}
	return c.seen.ui[i], true, nil
}

func (c *computer) find(name string, wait time.Duration) (uiNode, error) {
	reader, ok := c.screen.(uiReader)
	if !ok || c.seen == nil {
		return uiNode{}, errors.New("elements by name need a look first, on a computer whose windows give their elements")
	}
	for deadline := time.Now().Add(wait); ; time.Sleep(uiPoll) {
		nodes, read := c.observe(reader, c.seen.origin)
		c.seen.ui, c.seen.window = nodes, read
		var found []uiNode
		for i, n := range nodes {
			if i > 0 && called(n.name, name) {
				found = append(found, n)
			}
		}
		switch {
		case len(found) == 1:
			return found[0], nil
		case len(found) > 1:
			ids := make([]string, len(found))
			for i, n := range found {
				ids[i] = fmt.Sprintf("[%d]", n.id)
			}
			return uiNode{}, fmt.Errorf("%d elements are called %q (%s): use an id", len(found), name, strings.Join(ids, " "))
		case time.Now().After(deadline):
			return uiNode{}, fmt.Errorf("no element called %q in the window", name)
		}
	}
}

func called(full, name string) bool {
	return full == name || strings.HasPrefix(full, name+" | ") || strings.HasPrefix(full, name+" =")
}

func (c *computer) clickNode(n uiNode, s step) error {
	if n.target != nil && cmp.Or(s.Button, "left") == "left" {
		if err := c.press(n, s); err == nil || !n.placed {
			return err
		}
	}
	if n.placed {
		// why: the element's window may be behind another, and a click at its position would land on the window in front
		if err := c.front(step{Action: "key"}); err != nil {
			return err
		}
		return c.click(n.x, n.y, cmp.Or(s.Button, "left"), max(s.Count, 1), heldKeys(s.Keys))
	}
	return fmt.Errorf("element [%d] has no position or action: look with image true and click its x, y", n.id)
}

// why: acting on the element through accessibility leaves the user's pointer and front window alone; the mouse is the fallback
func (c *computer) press(n uiNode, s step) error {
	if s.Count < 2 {
		return n.target.activate(s.Keys != "")
	}
	if opener, ok := n.target.(uiOpener); ok {
		return opener.open()
	}
	if !n.target.selects() {
		return n.target.activate(false)
	}
	// why: GTK4 list and grid cells have no action and no position, so opening one is selecting it and pressing return
	if err := n.target.activate(false); err != nil {
		return err
	}
	return c.key("return")
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
	if len(mods) == 0 {
		return act()
	}
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
	// why: WinUI apps such as Notepad check whether ctrl is down when they handle the key, not when it was sent; a chord sent at once pasted a bare "v" or nothing
	time.Sleep(chordHold)
	acted := act()
	time.Sleep(chordHold)
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
		c.awaitPaste(board)
	}
	return nil
}

const stepPause = 60 * time.Millisecond

func (c *computer) awaitPaste(board clipboard) {
	watch, ok := board.(pasteReads)
	if !ok {
		// why: the app reads the clipboard after the paste keys arrive, so the next line or the restored clipboard must wait for it
		time.Sleep(pasteRead)
		return
	}
	select {
	case <-watch.reads():
	case <-time.After(pasteRead):
	}
}

func pauseAfter(s step) time.Duration {
	if s.Action != "key" {
		return stepPause
	}
	mods, key, err := keyChord(s.Keys)
	if err != nil {
		return stepPause
	}
	// why: a command shortcut can open a sheet or a dialog; TextEdit pressed cmd+shift+t then cmd+s 60 ms apart and stopped answering accessibility until it was killed
	if key == "return" || key == "esc" || slices.Contains(mods, "cmd") || slices.Contains(mods, "ctrl") {
		return settle
	}
	return stepPause
}

func (c *computer) act(steps []step, picture bool) ([]any, error) {
	for i, s := range steps {
		err := c.front(s)
		if err == nil {
			err = c.run(s)
		}
		if err != nil {
			failure := fmt.Errorf("step %d (%s): %w; earlier steps were done, later steps were not run", i+1, s.Action, err)
			content, captureError := c.shot(c.lastDisplay(), picture)
			if captureError != nil {
				return content, errors.Join(failure, fmt.Errorf("failure screenshot: %w", captureError))
			}
			return content, failure
		}
		if i+1 < len(steps) {
			c.pause(s, steps[i+1])
		}
	}
	c.settle()
	return c.look(c.lastDisplay(), picture, true)
}

// why: the window looked at can be on one display while another display's window has the keyboard, and keys sent then land in that other window
func (c *computer) front(s step) error {
	keyboard := s.Action == "key" || (s.Action == "type" && s.ID == 0 && s.Name == "")
	if !keyboard || c.seen == nil || len(c.seen.ui) == 0 {
		return nil
	}
	if !c.seen.window {
		return nil
	}
	looked := c.seen.ui[0]
	if looked.target == nil || c.inFront(looked) {
		return nil
	}
	if err := looked.target.activate(false); err != nil {
		return fmt.Errorf("the keys were not sent: %q is not in front and could not be brought there (%w)", looked.name, err)
	}
	time.Sleep(settle)
	if !c.inFront(looked) {
		_, window, _, _ := c.screen.state()
		return fmt.Errorf("the keys were not sent: %q is in front, not %q; click the window to work in first", window, looked.name)
	}
	return nil
}

type uiFront interface {
	inFront() bool
}

func (c *computer) inFront(looked uiNode) bool {
	if window, ok := looked.target.(uiFront); ok {
		return window.inFront()
	}
	_, window, _, _ := c.screen.state()
	return window == "" || window == looked.name
}

func (c *computer) pause(done, next step) {
	reader, ok := c.screen.(focusReader)
	if !ok {
		time.Sleep(pauseAfter(done))
		return
	}
	if pauseAfter(done) == settle {
		c.settle()
	} else {
		time.Sleep(stepPause)
	}
	if next.Action == "type" {
		// why: a field the last key opened takes a moment to take the focus; Finder's new folder name took 312–360 ms, and text typed before that landed on the list
		awaitFocus(reader, func(f focus) bool { return f.editable }, typeReady)
	}
}

func (c *computer) settle() {
	reader, ok := c.screen.(focusReader)
	if !ok {
		time.Sleep(settle)
		return
	}
	before, _ := reader.focused()
	changed := awaitFocus(reader, func(f focus) bool { return f != before }, settle)
	if !changed {
		return
	}
	last, quietSince := before, time.Now()
	for deadline := time.Now().Add(settle); time.Since(quietSince) < focusQuiet && time.Now().Before(deadline); time.Sleep(focusPoll) {
		if now, _ := reader.focused(); now != last {
			last, quietSince = now, time.Now()
		}
	}
}

func awaitFocus(reader focusReader, ready func(focus) bool, limit time.Duration) bool {
	for deadline := time.Now().Add(limit); time.Now().Before(deadline); time.Sleep(focusPoll) {
		if now, ok := reader.focused(); ok && ready(now) {
			return true
		}
	}
	return false
}

var computerTools = []map[string]any{
	{
		"name":        "screenshot",
		"description": "See one display of the computer's screen now (the one looked at last; work on one display at a time), as text first: its size, the front app, the title of its focused window, the focused element (its role, the last lines of its text, the selection, and where the caret is), the pointer, which display of how many when there are several, and ui: the elements of the top window on that display, one a line, indented by nesting, numbered, with role, name, @x,y of its center when known, and focused, selected, on or disabled, then the other windows on that display, behind. A JPEG of the display comes too when image is true, or by itself when the window gives no ui (a canvas, a game, an app without accessibility); ask for it only when the text cannot answer, such as how something looks. Coordinates everywhere are pixels of a screenshot of that display, until the next look. Apps opened while using the screen are quit two minutes after the last use.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"display": map[string]any{"type": "integer", "description": "1 is the main display, 2 and up the others; by default the one looked at last (the main one at first)"}, "image": map[string]any{"type": "boolean", "description": "also return a JPEG of the display; the text usually is enough"}, "window": map[string]any{"type": "string", "description": "the title of a window on the display to look at and work in without bringing it to the front (\"\" for the top window again)"}}},
		"annotations": map[string]any{"title": "Screenshot", "readOnlyHint": true},
	},
	{
		"name": "act",
		"description": "Use the mouse and keyboard, then see the result: runs the steps in order and returns the look after them, as screenshot does (text, and a JPEG only when image is true or there is no ui); when the same window is still on top, ui lists only the lines that changed, and the ids of the others still hold. " +
			"Clicks and typing on an element (id or name) go through accessibility and leave the user's pointer and front window alone when the element allows; keys and x, y clicks need the window in front. " +
			"Put the steps you can already tell in one call (click a field, type, press return); prefer keys to clicks. " +
			"Steps: click {id of a ui element from the last look, or name of one in the window now (exact, or what comes before \" | \" or \" =\" in it; for things that appear during these steps), or x, y; button: left (default), right, or middle; count: 2 for a double click; keys: modifiers held during it, such as \"cmd\" or \"shift\"}; move {x, y}; drag {x, y, to_x, to_y}; " +
			"scroll {x, y, dy and dx in lines, positive down and right}; key {keys: such as \"cmd+shift+t\", \"return\", \"esc\", \"down\"}; type {text; with an id or name: written into that element without the keyboard when it allows, so the window can stay behind}; wait {ms, or name: until an element with that name is in the window, up to ms (3000 by default)}. The text in ui is exact: no image is needed to check text, names or selection.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"steps": map[string]any{
					"type": "array",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"action": map[string]any{"type": "string", "enum": []string{"click", "move", "drag", "scroll", "key", "type", "wait"}},
							"id":     map[string]any{"type": "integer", "description": "a ui element's [number] from the last look, for click instead of x, y"},
							"name":   map[string]any{"type": "string", "description": "a ui element's name, for click or wait, looked up when the step runs"},
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
				"image": map[string]any{"type": "boolean", "description": "also return a JPEG of the display; the text usually is enough"},
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

func Serve(version, state string) int {
	s, err := newScreen(state)
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
					Steps   []step  `json:"steps"`
					Display int     `json:"display"`
					Image   bool    `json:"image"`
					Window  *string `json:"window"`
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
				if p.Arguments.Window != nil {
					c.watch = untagged(*p.Arguments.Window)
				}
				content, err = c.shot(cmp.Or(p.Arguments.Display, c.lastDisplay()), p.Arguments.Image)
			case "act":
				content, err = c.act(p.Arguments.Steps, p.Arguments.Image)
			default:
				err = fmt.Errorf("no tool %q", p.Name)
			}
			result := map[string]any{"content": content}
			if err != nil {
				result = map[string]any{"isError": true, "content": append([]any{map[string]any{"type": "text", "text": err.Error()}}, content...)}
			}
			reply(m.ID, result)
			c.noteOpened()
		default:
			fail(m.ID, -32601, "method not found: "+m.Method)
		}
	}
	return 0
}

func keyChord(keys string) (mods []string, key string, err error) {
	chord := strings.TrimSpace(keys)
	if chord == "+" || strings.HasSuffix(chord, "++") {
		chord = chord[:len(chord)-1] + "plus"
	}
	parts := heldKeys(chord)
	if len(parts) == 0 || strings.HasSuffix(chord, "+") {
		return nil, "", fmt.Errorf("no key in %q", keys)
	}
	return parts[:len(parts)-1], parts[len(parts)-1], nil
}

var keyAliases = map[string]string{
	"control": "ctrl", "option": "alt", "opt": "alt", "command": "cmd", "meta": "cmd", "super": "cmd", "win": "cmd",
	"enter": "return", "escape": "esc", "delete": "backspace", "plus": "+",
}

func heldKeys(keys string) []string {
	var names []string
	for _, part := range strings.Split(strings.ToLower(keys), "+") {
		if name := strings.TrimSpace(part); name != "" {
			names = append(names, cmp.Or(keyAliases[name], name))
		}
	}
	return names
}
