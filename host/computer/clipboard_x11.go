//go:build linux

package computer

import (
	"errors"
	"sync"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

const clipboardLimit = 200_000

var errNoClipboardText = errors.New("the clipboard holds something other than text, so it would not survive a paste")

type selection struct {
	conn                                 *xgb.Conn
	window                               xproto.Window
	clipboard, targets, utf8, plain, got xproto.Atom
	incr                                 xproto.Atom
	notified                             chan xproto.SelectionNotifyEvent
	taken                                chan struct{}
	mu                                   sync.Mutex
	text                                 string
}

func (s *x11Screen) selection() (*selection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clip != nil {
		return s.clip, nil
	}
	window, err := xproto.NewWindowId(s.conn)
	if err != nil {
		return nil, err
	}
	if err := xproto.CreateWindowChecked(s.conn, 0, window, s.root, 0, 0, 1, 1, 0, xproto.WindowClassInputOnly, 0, 0, nil).Check(); err != nil {
		return nil, err
	}
	sel := &selection{
		conn: s.conn, window: window, notified: make(chan xproto.SelectionNotifyEvent, 1), taken: make(chan struct{}, 1),
		clipboard: s.atom("CLIPBOARD"), targets: s.atom("TARGETS"), utf8: s.atom("UTF8_STRING"),
		plain: s.atom("text/plain;charset=utf-8"), got: s.atom("PI_MOBILE_CLIPBOARD"), incr: s.atom("INCR"),
	}
	go sel.serve()
	s.clip = sel
	return sel, nil
}

func (sel *selection) serve() {
	for {
		event, err := sel.conn.WaitForEvent()
		if event == nil && err == nil {
			return
		}
		switch e := event.(type) {
		case xproto.SelectionRequestEvent:
			sel.answer(e)
		case xproto.SelectionNotifyEvent:
			select {
			case sel.notified <- e:
			default:
			}
		}
	}
}

func (sel *selection) answer(e xproto.SelectionRequestEvent) {
	property := e.Property
	if property == xproto.AtomNone {
		property = e.Target
	}
	sel.mu.Lock()
	text := sel.text
	sel.mu.Unlock()
	switch {
	case e.Selection != sel.clipboard:
		property = xproto.AtomNone
	case e.Target == sel.targets:
		atoms := []xproto.Atom{sel.targets, sel.utf8, sel.plain}
		data := make([]byte, 4*len(atoms))
		for i, atom := range atoms {
			xgb.Put32(data[4*i:], uint32(atom))
		}
		xproto.ChangeProperty(sel.conn, xproto.PropModeReplace, e.Requestor, property, xproto.AtomAtom, 32, uint32(len(atoms)), data)
	case e.Target == sel.utf8 || e.Target == sel.plain:
		xproto.ChangeProperty(sel.conn, xproto.PropModeReplace, e.Requestor, property, e.Target, 8, uint32(len(text)), []byte(text))
		defer poke(sel.taken)
	default:
		property = xproto.AtomNone
	}
	reply := xproto.SelectionNotifyEvent{Time: e.Time, Requestor: e.Requestor, Selection: e.Selection, Target: e.Target, Property: property}
	xproto.SendEvent(sel.conn, false, e.Requestor, xproto.EventMaskNoEvent, string(reply.Bytes()))
}

func (sel *selection) owned() bool {
	owner, err := xproto.GetSelectionOwner(sel.conn, sel.clipboard).Reply()
	return err == nil && owner.Owner == sel.window
}

func (sel *selection) own(text string) error {
	sel.mu.Lock()
	sel.text = text
	sel.mu.Unlock()
	drain(sel.taken)
	xproto.SetSelectionOwner(sel.conn, sel.window, sel.clipboard, xproto.TimeCurrentTime)
	if !sel.owned() {
		return errors.New("another app kept the clipboard")
	}
	return nil
}

func (sel *selection) read() (string, error) {
	select {
	case <-sel.notified:
	default:
	}
	xproto.ConvertSelection(sel.conn, sel.window, sel.clipboard, sel.utf8, sel.got, xproto.TimeCurrentTime)
	select {
	case e := <-sel.notified:
		if e.Property == xproto.AtomNone {
			return "", errNoClipboardText
		}
	case <-time.After(time.Second):
		return "", errors.New("the app holding the clipboard did not answer")
	}
	reply, err := xproto.GetProperty(sel.conn, true, sel.window, sel.got, xproto.GetPropertyTypeAny, 0, clipboardLimit).Reply()
	if err != nil {
		return "", err
	}
	if reply.Type == sel.incr || reply.BytesAfter > 0 {
		return "", errors.New("the clipboard is too large to put back")
	}
	return string(reply.Value), nil
}

func (s *x11Screen) holdClipboard() (func() error, error) {
	sel, err := s.selection()
	if err != nil {
		return nil, err
	}
	owner, err := xproto.GetSelectionOwner(sel.conn, sel.clipboard).Reply()
	if err != nil {
		return nil, err
	}
	if owner.Owner == xproto.WindowNone {
		return func() error {
			if sel.owned() {
				xproto.SetSelectionOwner(sel.conn, xproto.WindowNone, sel.clipboard, xproto.TimeCurrentTime)
			}
			return nil
		}, nil
	}
	saved, err := sel.read()
	if err != nil {
		return nil, err
	}
	return func() error {
		if !sel.owned() {
			return nil
		}
		return sel.own(saved)
	}, nil
}

func (s *x11Screen) putClipboard(text string) error {
	if len(text) > clipboardLimit {
		return errors.New("the line is too long to paste")
	}
	sel, err := s.selection()
	if err != nil {
		return err
	}
	return sel.own(text)
}

func (s *x11Screen) pasteKeys() string { return "ctrl+v" }

func (s *x11Screen) reads() <-chan struct{} {
	sel, err := s.selection()
	if err != nil {
		return nil
	}
	return sel.taken
}
