package computer

import (
	"fmt"
	"strings"

	"github.com/godbus/dbus/v5"
)

const (
	stateChecked    = 4
	stateFocusable  = 11
	statePressed    = 20
	stateSelectable = 22
	stateSelected   = 23
	stateEnabled    = 24
	stateShowing    = 25
	screenCoords    = uint32(0)
	atspiRoot       = dbus.ObjectPath("/org/a11y/atspi/accessible/root")
)

var flattened = map[string]bool{"panel": true, "filler": true, "scroll pane": true, "viewport": true, "section": true, "grouping": true, "box": true, "generic": true, "group": true, "tab panel": true}

var skipped = map[string]bool{"scroll bar": true, "separator": true, "image": true, "icon": true}

var rows = map[string]bool{"table row": true, "list item": true, "tree item": true}

func (a *accessibility) window(_ display, title string) uiView {
	if a == nil {
		return uiView{}
	}
	sender, _ := a.current()
	if sender == "" {
		return uiView{}
	}
	frames := a.children(node{sender, atspiRoot})
	if len(frames) == 0 {
		return uiView{}
	}
	front := frames[0]
	for _, frame := range frames {
		if a.has(frame, stateActive) {
			front = frame
			break
		}
	}
	if title != "" {
		front = a.titled(title, front)
	}
	walk := &atspiWalker{a: a}
	walk.visit(front, 0)
	if len(walk.nodes) > 0 {
		walk.nodes[0].target = nil
	}
	return uiView{window: walk.nodes}
}

type atspiWalker struct {
	a     *accessibility
	nodes []uiNode
	seen  int
}

func (w *atspiWalker) visit(at node, depth int) {
	if w.seen >= uiWalk || depth > uiDepth {
		return
	}
	w.seen++
	element := w.a.bus.Object(at.Sender, at.Path)
	var role string
	if element.Call(atspi+"Accessible.GetRoleName", 0).Store(&role) != nil || skipped[role] {
		return
	}
	var states []uint32
	element.Call(atspi+"Accessible.GetState", 0).Store(&states)
	state := func(bit uint) bool { return len(states) > 0 && states[0]&(1<<bit) != 0 }
	if depth > 0 && !state(stateShowing) {
		return
	}
	n := uiNode{depth: depth, role: role, focused: state(stateFocused), selected: state(stateSelected), checked: state(stateChecked) || state(statePressed), disabled: !state(stateEnabled)}
	n.target = atspiTarget{a: w.a, at: at, selectable: state(stateSelectable), editable: state(stateEditable) && state(stateFocusable)}
	if name, err := element.GetProperty(atspi + "Accessible.Name"); err == nil {
		n.name, _ = name.Value().(string)
	}
	if text := w.text(element); text != "" && text != n.name {
		n.name = strings.TrimSpace(n.name + " =" + text)
	}
	var x, y, width, height int32
	if element.Call(atspi+"Component.GetExtents", 0, screenCoords).Store(&x, &y, &width, &height) == nil && width > 1 && height > 1 && (x > 0 || y > 0) {
		n.x, n.y, n.placed = float64(x)+float64(width)/2, float64(y)+float64(height)/2, true
	}
	children := w.a.children(at)
	if rows[role] && n.name == "" {
		n.name = strings.Join(w.names(children, 0), " | ")
		w.nodes = append(w.nodes, n)
		return
	}
	if flattened[role] && n.name == "" {
		for _, child := range children {
			w.visit(child, depth)
		}
		return
	}
	w.nodes = append(w.nodes, n)
	for _, child := range children {
		w.visit(child, depth+1)
	}
}

func (w *atspiWalker) text(element dbus.BusObject) string {
	count, err := element.GetProperty(textCount)
	if err != nil {
		return ""
	}
	length, _ := count.Value().(int32)
	var text string
	if length == 0 || element.Call(atspi+"Text.GetText", 0, int32(0), min(length, uiName+1)).Store(&text) != nil {
		return ""
	}
	return strings.TrimSpace(text)
}

func (w *atspiWalker) names(children []node, depth int) []string {
	if depth > 4 {
		return nil
	}
	var found []string
	for _, child := range children {
		if name, err := w.a.bus.Object(child.Sender, child.Path).GetProperty(atspi + "Accessible.Name"); err == nil {
			if text, _ := name.Value().(string); text != "" {
				found = append(found, text)
			}
		}
		found = append(found, w.names(w.a.children(child), depth+1)...)
	}
	return found
}

type atspiTarget struct {
	a                    *accessibility
	at                   node
	selectable, editable bool
}

func (t atspiTarget) selects() bool { return t.selectable }

func (t atspiTarget) activate(adding bool) error {
	element := t.a.bus.Object(t.at.Sender, t.at.Path)
	switch {
	case t.selectable:
		var parent node
		var index int32
		if err := element.Call(atspi+"Accessible.GetIndexInParent", 0).Store(&index); err != nil {
			return err
		}
		if err := element.StoreProperty(atspi+"Accessible.Parent", &parent); err != nil {
			return err
		}
		list := t.a.bus.Object(parent.Sender, parent.Path)
		if !adding {
			list.Call(atspi+"Selection.ClearSelection", 0)
		}
		var done bool
		if err := list.Call(atspi+"Selection.SelectChild", 0, index).Store(&done); err != nil || !done {
			return fmt.Errorf("the list did not select it: %v", err)
		}
		return nil
	case t.editable:
		var done bool
		if err := element.Call(atspi+"Component.GrabFocus", 0).Store(&done); err != nil || !done {
			return fmt.Errorf("it did not take the focus: %v", err)
		}
		return nil
	}
	var done bool
	if err := element.Call(atspi+"Action.DoAction", 0, int32(0)).Store(&done); err != nil || !done {
		return fmt.Errorf("it has no action: %v", err)
	}
	return nil
}

func (a *accessibility) titled(title string, otherwise node) node {
	var apps []node
	if a.bus.Object(atspi+"Registry", atspiRoot).Call(atspi+"Accessible.GetChildren", 0).Store(&apps) != nil {
		return otherwise
	}
	for _, app := range apps {
		for _, frame := range a.children(app) {
			if name, err := a.bus.Object(frame.Sender, frame.Path).GetProperty(atspi + "Accessible.Name"); err == nil && name.Value() == title {
				return frame
			}
		}
	}
	return otherwise
}

func (t atspiTarget) write(text string) error {
	element := t.a.bus.Object(t.at.Sender, t.at.Path)
	at := int32(0)
	if caret, err := element.GetProperty(textCaret); err == nil {
		at, _ = caret.Value().(int32)
	}
	var done bool
	if err := element.Call(atspi+"EditableText.InsertText", 0, at, text, int32(len([]rune(text)))).Store(&done); err != nil || !done {
		return fmt.Errorf("the field did not take the text: %v", err)
	}
	return nil
}
