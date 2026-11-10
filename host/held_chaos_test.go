package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type chaosSend struct {
	kind websocket.MessageType
	data []byte
}

type chaosPhone struct {
	t        *testing.T
	server   string
	token    string
	conn     *websocket.Conn
	down     bool
	sent     []chaosSend
	received int
	stdout   strings.Builder
	texts    []string
	closed   string
	trace    []string
}

func (p *chaosPhone) attach() bool {
	conn, _, err := websocket.Dial(context.Background(), p.server+"/exec?attach="+p.token+"&received="+fmt.Sprint(p.received), nil)
	if err != nil {
		p.t.Fatalf("attach: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	kind, data, err := conn.Read(ctx)
	if err != nil {
		p.closed = websocket.CloseStatus(err).String() + ":" + closeReasonOf(err)
		return false
	}
	var resume struct{ Received int }
	if kind != websocket.MessageText || json.Unmarshal(data, &resume) != nil {
		p.t.Fatalf("resume handshake %s %q", kind, data)
	}
	p.conn = conn
	p.down = false
	p.trace = append(p.trace, fmt.Sprintf("attach have=%d computer-has=%d", p.received, resume.Received))
	for _, m := range p.sent[resume.Received:] {
		if err := conn.Write(context.Background(), m.kind, m.data); err != nil {
			p.down = true
			return true
		}
	}
	return true
}

func (p *chaosPhone) send(kind websocket.MessageType, data []byte) {
	p.sent = append(p.sent, chaosSend{kind, data})
	if p.down {
		return
	}
	if err := p.conn.Write(context.Background(), kind, data); err != nil {
		p.trace = append(p.trace, "write failed")
		p.down = true
	}
}

func (p *chaosPhone) drop() {
	_ = p.conn.CloseNow()
	p.down = true
}

func (p *chaosPhone) reattach(seed int64) {
	for p.down {
		if !p.attach() {
			p.t.Fatalf("seed %d: attach refused %s; %v", seed, p.closed, p.trace)
		}
	}
}

func (p *chaosPhone) read(within time.Duration) bool {
	if p.down {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	kind, data, err := p.conn.Read(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return true
		}
		p.closed = websocket.CloseStatus(err).String() + ":" + closeReasonOf(err)
		if websocket.CloseStatus(err) == -1 {
			p.down = true
			return true
		}
		return false
	}
	p.received++
	if kind == websocket.MessageText {
		p.texts = append(p.texts, string(data))
		return true
	}
	if len(data) > 0 && data[0] == 1 {
		p.stdout.WriteString(string(data[1:]))
	}
	return true
}

func TestAHeldSessionDeliversEverythingExactlyOnceThroughAnyMixOfDrops(t *testing.T) {
	server := execServer(t)
	base := "ws" + strings.TrimPrefix(server.URL, "http")
	for seed := int64(1); seed <= 12; seed++ {
		random := rand.New(rand.NewSource(seed))
		token := fmt.Sprintf("%032x", time.Now().UnixNano()+seed)
		phone := &chaosPhone{t: t, server: base, token: token}
		conn, _, err := websocket.Dial(context.Background(), base+"/exec?session="+token+"&command="+url.QueryEscape("cat"), nil)
		if err != nil {
			t.Fatal(err)
		}
		phone.conn = conn
		var want strings.Builder
		ready := []byte("ready\n")
		want.Write(ready)
		phone.send(websocket.MessageBinary, ready)
		for phone.stdout.Len() == 0 {
			if !phone.read(3 * time.Second) {
				t.Fatalf("seed %d: no echo of the first line: %s", seed, phone.closed)
			}
		}
		for line := 0; line < 20; line++ {
			data := []byte(fmt.Sprintf("line %d\n", line))
			want.Write(data)
			phone.send(websocket.MessageBinary, data)
			switch roll := random.Float64(); {
			case roll < 0.35:
				phone.read(time.Duration(random.Intn(30)) * time.Millisecond)
			case roll < 0.6:
				phone.trace = append(phone.trace, fmt.Sprintf("drop after line %d", line))
				phone.drop()
				time.Sleep(time.Duration(random.Intn(20)) * time.Millisecond)
			}
			phone.reattach(seed)
		}
		phone.send(websocket.MessageText, []byte("eof"))
		for {
			phone.reattach(seed)
			phone.closed = ""
			if !phone.read(3*time.Second) && !phone.down {
				break
			}
		}
		context := fmt.Sprintf("seed %d: %v", seed, phone.trace)
		if phone.stdout.String() != want.String() {
			t.Fatalf("stdout %q, want %q; %s", phone.stdout.String(), want.String(), context)
		}
		if strings.Join(phone.texts, " ") != `{"exit":0}` {
			t.Fatalf("texts %q; %s", phone.texts, context)
		}
		if !strings.HasPrefix(phone.closed, "StatusNormalClosure") {
			t.Fatalf("closed %q; %s", phone.closed, context)
		}
		time.Sleep(50 * time.Millisecond)
		if takeSession("exec:"+token, digest("")) != nil {
			t.Fatalf("the finished session is still held; %s", context)
		}
	}
}
