package main

import (
	"sync"

	"github.com/godbus/dbus/v5"
)

const (
	atspi         = "org.a11y.atspi."
	stateActive   = 1
	stateEditable = 7
	stateFocused  = 12
	searchLimit   = 3000
	textCaret     = atspi + "Text.CaretOffset"
	textCount     = atspi + "Text.CharacterCount"
)

type accessibility struct {
	bus    *dbus.Conn
	mu     sync.Mutex
	sender string
	path   dbus.ObjectPath
}

func startAccessibility() *accessibility {
	session, err := dbus.SessionBus()
	if err != nil {
		return nil
	}
	var address string
	if session.Object("org.a11y.Bus", "/org/a11y/bus").Call("org.a11y.Bus.GetAddress", 0).Store(&address) != nil {
		return nil
	}
	bus, err := dbus.Dial(address)
	if err != nil {
		return nil
	}
	if bus.Auth(nil) != nil || bus.Hello() != nil {
		bus.Close()
		return nil
	}
	registry := bus.Object(atspi+"Registry", "/org/a11y/atspi/registry")
	if registry.Call(atspi+"Registry.RegisterEvent", 0, "object:state-changed:focused", []string{}, "").Err != nil {
		registry.Call(atspi+"Registry.RegisterEvent", 0, "object:state-changed:focused")
	}
	if bus.AddMatchSignal(dbus.WithMatchInterface(atspi+"Event.Object"), dbus.WithMatchMember("StateChanged")) != nil {
		bus.Close()
		return nil
	}
	a := &accessibility{bus: bus}
	signals := make(chan *dbus.Signal, 64)
	bus.Signal(signals)
	go a.follow(signals)
	return a
}

func (a *accessibility) follow(signals chan *dbus.Signal) {
	for signal := range signals {
		if len(signal.Body) < 2 {
			continue
		}
		kind, _ := signal.Body[0].(string)
		gained, _ := signal.Body[1].(int32)
		if kind != "focused" || gained != 1 {
			continue
		}
		a.mu.Lock()
		a.sender, a.path = signal.Sender, signal.Path
		a.mu.Unlock()
	}
}

type node struct {
	Sender string
	Path   dbus.ObjectPath
}

// why: focus events only tell where the focus moves; an app that had it before the host started says nothing until it moves, so the first read looks for it once
func (a *accessibility) search() (string, dbus.ObjectPath) {
	var apps []node
	if a.bus.Object(atspi+"Registry", "/org/a11y/atspi/accessible/root").Call(atspi+"Accessible.GetChildren", 0).Store(&apps) != nil {
		return "", ""
	}
	var frames, active []node
	for _, app := range apps {
		frames = append(frames, a.children(app)...)
	}
	for _, frame := range frames {
		if a.has(frame, stateActive) {
			active = append(active, frame)
		}
	}
	queue := append(active, frames...)
	for seen := 0; len(queue) > 0 && seen < searchLimit; seen++ {
		next := queue[0]
		queue = queue[1:]
		if a.has(next, stateFocused) {
			return next.Sender, next.Path
		}
		queue = append(queue, a.children(next)...)
	}
	return "", ""
}

func (a *accessibility) children(of node) []node {
	var found []node
	a.bus.Object(of.Sender, of.Path).Call(atspi+"Accessible.GetChildren", 0).Store(&found)
	return found
}

func (a *accessibility) has(of node, state uint) bool {
	var states []uint32
	return a.bus.Object(of.Sender, of.Path).Call(atspi+"Accessible.GetState", 0).Store(&states) == nil && len(states) > 0 && states[0]&(1<<state) != 0
}

func (a *accessibility) focused() (focus, bool) {
	if a == nil {
		return focus{}, false
	}
	a.mu.Lock()
	sender, path := a.sender, a.path
	a.mu.Unlock()
	if sender == "" {
		sender, path = a.search()
		if sender == "" {
			return focus{}, false
		}
		a.mu.Lock()
		if a.sender == "" {
			a.sender, a.path = sender, path
		}
		a.mu.Unlock()
	}
	element := a.bus.Object(sender, path)
	var role string
	if element.Call(atspi+"Accessible.GetRoleName", 0).Store(&role) != nil {
		return focus{}, false
	}
	f := focus{role: role, caret: -1}
	var states []uint32
	if element.Call(atspi+"Accessible.GetState", 0).Store(&states) == nil && len(states) > 0 {
		f.editable = states[0]&(1<<stateEditable) != 0
	}
	if role == "password text" {
		f.secret = true
		return f, true
	}
	count, err := element.GetProperty(textCount)
	if err != nil {
		return f, true
	}
	length, _ := count.Value().(int32)
	var end string
	if element.Call(atspi+"Text.GetText", 0, max(length-focusTail, 0), length).Store(&end) != nil {
		return f, true
	}
	f.length, f.end = int(length), end
	if caret, err := element.GetProperty(textCaret); err == nil {
		if at, ok := caret.Value().(int32); ok && at >= 0 {
			f.caret = int(length - at)
		}
	}
	var from, to int32
	if element.Call(atspi+"Text.GetSelection", 0, int32(0)).Store(&from, &to) == nil && to > from {
		var picked string
		if element.Call(atspi+"Text.GetText", 0, from, min(to, from+focusTail)).Store(&picked) == nil {
			f.selected = picked
		}
	}
	return f, true
}
