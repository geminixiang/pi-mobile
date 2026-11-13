package main

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestHeldLinkTransitions(t *testing.T) {
	now := time.Date(2026, 11, 14, 3, 0, 0, 0, time.UTC)
	later := now.Add(holdFor)
	old, fresh := new(websocket.Conn), new(websocket.Conn)
	on := attached{conn: old, ctx: context.Background()}
	to := attached{conn: fresh, ctx: context.Background()}
	sent := outbox{messages: []message{{data: []byte("a")}, {data: []byte("b")}}, base: 3}
	step := func(next link, effects []effect) func() (link, []effect) {
		return func() (link, []effect) { return next, effects }
	}
	attach := func(state link, have int) func() (link, []effect) {
		next, effects, refused := onAttach(state, to, have, sent)
		if refused != "" {
			return step(state, []effect{closeLink{fresh, refused}})
		}
		return step(next, effects)
	}
	refusedWith := func(reason string) []effect { return []effect{closeLink{fresh, reason}} }
	cases := []struct {
		name  string
		got   func() (link, []effect)
		state link
		does  []effect
	}{
		{"an attached link that drops is held until the grace ends", step(onDrop(on, old, later)), away{later}, nil},
		{"a drop of a link that was already replaced changes nothing", step(onDrop(to, old, later)), to, nil},
		{"a drop while away changes nothing", step(onDrop(away{now}, old, later)), away{now}, nil},
		{"a drop after the command exited changes nothing", step(onDrop(exited{now, "x"}, old, later)), exited{now, "x"}, nil},
		{"a drop of a finished session changes nothing", step(onDrop(finished{}, old, later)), finished{}, nil},

		{"a phone that comes back takes the link and gets what it missed", attach(away{now}, 4), to, []effect{replay{to, 4}}},
		{"a phone that attaches over a live link replaces it", attach(on, 5), to, []effect{closeLink{old, sessionReplace}, replay{to, 5}}},
		{"a phone that comes back after the command exited gets the rest and the session ends", attach(exited{now, "pi-env exited"}, 3), finished{}, []effect{replay{to, 3}, closeLink{fresh, "pi-env exited"}, release{}}},
		{"a finished session refuses an attach", attach(finished{}, 3), finished{}, refusedWith(sessionGone)},
		{"an attach older than what is kept is refused", attach(away{now}, 2), away{now}, refusedWith(sessionBehind)},
		{"an attach that claims more than was sent is refused", attach(away{now}, 6), away{now}, refusedWith(sessionBehind)},
		{"a finished session refuses an attach before checking the count", attach(finished{}, 99), finished{}, refusedWith(sessionGone)},

		{"a command that exits while attached closes the link with its reason", step(onExit(on, "done")), finished{}, []effect{closeLink{old, "done"}, release{}}},
		{"a command that exits while away waits for the phone until the grace ends", step(onExit(away{later}, "done")), exited{later, "done"}, nil},
		{"a second exit changes nothing", step(onExit(exited{later, "first"}, "second")), exited{later, "first"}, nil},
		{"an exit after the session finished changes nothing", step(onExit(finished{}, "done")), finished{}, nil},

		{"killing an attached session closes the link and stops the command", step(onKill(on, unpaired)), finished{}, []effect{closeLink{old, unpaired}, release{}, stopCommand{}}},
		{"killing a session that is away stops the command", step(onKill(away{later}, sessionGone)), finished{}, []effect{release{}, stopCommand{}}},
		{"killing a session whose command exited releases it", step(onKill(exited{later, "done"}, sessionGone)), finished{}, []effect{release{}, stopCommand{}}},
		{"killing a finished session changes nothing", step(onKill(finished{}, sessionGone)), finished{}, nil},

		{"the grace ending lets the session go", step(onExpire(away{later}, later)), finished{}, []effect{release{}, stopCommand{}}},
		{"the grace ending after the command exited lets the output go", step(onExpire(exited{later, "done"}, later.Add(time.Second))), finished{}, []effect{release{}, stopCommand{}}},
		{"a timer from an earlier absence does not end a later one", step(onExpire(away{later}, now)), away{later}, nil},
		{"a timer firing after the phone came back changes nothing", step(onExpire(on, later)), on, nil},
		{"a timer firing after the session finished changes nothing", step(onExpire(finished{}, later)), finished{}, nil},
	}
	for _, c := range cases {
		state, effects := c.got()
		if !reflect.DeepEqual(state, c.state) || !reflect.DeepEqual(effects, c.does) {
			t.Errorf("%s: got %s %v, want %s %v", c.name, describe(state), effects, describe(c.state), c.does)
		}
	}
}

func describe(state link) string {
	return fmt.Sprintf("%T%+v", state, state)
}

func TestTheOutboxKeepsWhatAnAttachCanAskFor(t *testing.T) {
	var sent outbox
	for _, data := range []string{"aa", "bb", "cc"} {
		sent.push(message{data: []byte(data)})
	}
	sent.trim(4)
	if sent.base != 1 || sent.bytes != 4 || sent.end() != 3 {
		t.Fatalf("trimmed to base %d, %d bytes, end %d", sent.base, sent.bytes, sent.end())
	}
	if sent.covers(0) || !sent.covers(1) || !sent.covers(3) || sent.covers(4) {
		t.Fatal("covers the wrong counts")
	}
	if got := sent.since(2); len(got) != 1 || string(got[0].data) != "cc" {
		t.Fatalf("since 2 is %v", got)
	}
}
