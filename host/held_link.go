package main

import (
	"context"
	"time"

	"github.com/coder/websocket"
)

type link interface{ link() }

type attached struct {
	conn *websocket.Conn
	ctx  context.Context
}

type away struct{ until time.Time }

type exited struct {
	until  time.Time
	reason string
}

type finished struct{}

func (attached) link() {}
func (away) link()     {}
func (exited) link()   {}
func (finished) link() {}

type effect interface{ effect() }

type closeLink struct {
	conn   *websocket.Conn
	reason string
}

type replay struct {
	to   attached
	have int
}

type release struct{}

type stopCommand struct{}

func (closeLink) effect()   {}
func (replay) effect()      {}
func (release) effect()     {}
func (stopCommand) effect() {}

func graceOf(state link) (time.Time, bool) {
	switch state := state.(type) {
	case away:
		return state.until, true
	case exited:
		return state.until, true
	}
	return time.Time{}, false
}

func onAttach(state link, to attached, have int, sent outbox) (link, []effect, string) {
	if _, done := state.(finished); done {
		return state, nil, sessionGone
	}
	if !sent.covers(have) {
		return state, nil, sessionBehind
	}
	switch state := state.(type) {
	case attached:
		return to, []effect{closeLink{state.conn, sessionReplace}, replay{to, have}}, ""
	case exited:
		return finished{}, []effect{replay{to, have}, closeLink{to.conn, state.reason}, release{}}, ""
	}
	return to, []effect{replay{to, have}}, ""
}

func onDrop(state link, conn *websocket.Conn, until time.Time) (link, []effect) {
	if current, ok := state.(attached); !ok || current.conn != conn {
		return state, nil
	}
	return away{until}, nil
}

func onExit(state link, reason string) (link, []effect) {
	switch state := state.(type) {
	case attached:
		return finished{}, []effect{closeLink{state.conn, reason}, release{}}
	case away:
		return exited{state.until, reason}, nil
	}
	return state, nil
}

func onKill(state link, reason string) (link, []effect) {
	switch state := state.(type) {
	case finished:
		return state, nil
	case attached:
		return finished{}, []effect{closeLink{state.conn, reason}, release{}, stopCommand{}}
	}
	return finished{}, []effect{release{}, stopCommand{}}
}

func onExpire(state link, at time.Time) (link, []effect) {
	until, waiting := graceOf(state)
	if !waiting || at.Before(until) {
		return state, nil
	}
	return onKill(state, sessionGone)
}

type outbox struct {
	messages []message
	base     int
	bytes    int
}

func (o *outbox) push(m message) {
	o.messages = append(o.messages, m)
	o.bytes += len(m.data)
}

func (o *outbox) trim(limit int) {
	for o.bytes > limit && len(o.messages) > 0 {
		o.bytes -= len(o.messages[0].data)
		o.messages = o.messages[1:]
		o.base++
	}
}

func (o outbox) end() int {
	return o.base + len(o.messages)
}

func (o outbox) covers(have int) bool {
	return have >= o.base && have <= o.end()
}

func (o outbox) since(have int) []message {
	return o.messages[have-o.base:]
}
