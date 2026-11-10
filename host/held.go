package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os/exec"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	holdBytes      = 8 << 20
	sessionGone    = "no such session"
	sessionBehind  = "too far behind to resume"
	sessionReplace = "replaced by a newer connection"
	sessionTaken   = "session token in use"
	unpaired       = "this phone is no longer paired with this computer"
	pingEvery      = 10 * time.Second
	pingTimeout    = 10 * time.Second
	writeTimeout   = 10 * time.Second
	stdinGrace     = 2 * time.Second
)

var (
	holdFor        = time.Duration(protocol.HoldMinutes) * time.Minute
	heartbeatEvery = 5 * time.Second
)

type message struct {
	text bool
	data []byte
}

// why: a phone that loses its network sends no FIN, so the computer only learns of the loss from a failed write or an unanswered ping; held sessions keep pi-env alive themselves (heartbeat) instead of relying on the phone's pings reaching it.
type held struct {
	owner     string
	stdin     io.WriteCloser
	heartbeat []byte
	cancel    context.CancelFunc
	onEnd     func()

	mu        sync.Mutex
	link      link
	sent      []message
	sentBase  int
	sentBytes int
	received  int
	ended     *string
}

type link interface{ held() }

type attached struct {
	conn *websocket.Conn
	ctx  context.Context
}

type away struct{ grace *time.Timer }

type finished struct{}

func (attached) held() {}
func (away) held()     {}
func (finished) held() {}

func (h *held) attachedTo(conn *websocket.Conn) bool {
	current, ok := h.link.(attached)
	return ok && current.conn == conn
}

var (
	heldMu   sync.Mutex
	heldByID = map[string]*held{}
)

func holdSession(id string, session *held) {
	untrack := track(session.owner, func() { session.kill(unpaired) })
	heldMu.Lock()
	previous := heldByID[id]
	heldByID[id] = session
	session.onEnd = func() {
		untrack()
		heldMu.Lock()
		if heldByID[id] == session {
			delete(heldByID, id)
		}
		heldMu.Unlock()
	}
	heldMu.Unlock()
	if previous != nil {
		previous.kill(sessionGone)
	}
}

func (h *held) ownedBy(owner string) bool {
	return subtle.ConstantTimeCompare([]byte(h.owner), []byte(owner)) == 1
}

func takeSession(id, owner string) *held {
	heldMu.Lock()
	defer heldMu.Unlock()
	session := heldByID[id]
	if session == nil || !session.ownedBy(owner) {
		return nil
	}
	return session
}

func heldByOther(id, owner string) bool {
	heldMu.Lock()
	defer heldMu.Unlock()
	session := heldByID[id]
	return session != nil && !session.ownedBy(owner)
}

func (h *held) deliver(m message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sent = append(h.sent, m)
	h.sentBytes += len(m.data)
	current, attachedNow := h.link.(attached)
	for h.sentBytes > holdBytes && len(h.sent) > 0 {
		if !attachedNow {
			log.Printf("held session dropped: %d bytes waiting while the phone was away", h.sentBytes)
			h.killLocked(sessionGone)
			return
		}
		h.sentBytes -= len(h.sent[0].data)
		h.sent = h.sent[1:]
		h.sentBase++
	}
	if attachedNow {
		if err := writeMessage(current.conn, current.ctx, m); err != nil {
			h.detachLocked()
		}
	}
}

func writeMessage(conn *websocket.Conn, ctx context.Context, m message) error {
	kind := websocket.MessageBinary
	if m.text {
		kind = websocket.MessageText
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(ctx, kind, m.data)
}

func (h *held) end(final *message, closing string) {
	if final != nil {
		h.deliver(*final)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ended = &closing
	if current, ok := h.link.(attached); ok {
		go current.conn.Close(websocket.StatusNormalClosure, closing)
		h.finishLocked()
	}
}

func (h *held) finishLocked() {
	switch current := h.link.(type) {
	case finished:
		return
	case away:
		current.grace.Stop()
	}
	h.link = finished{}
	if h.onEnd != nil {
		h.onEnd()
	}
}

func (h *held) detachLocked() {
	if _, ok := h.link.(attached); !ok {
		return
	}
	if h.ended != nil {
		h.finishLocked()
		return
	}
	log.Printf("held session detached; keeping its command for %s", holdFor)
	h.link = away{grace: time.AfterFunc(holdFor, func() { h.kill(sessionGone) })}
}

func (h *held) keepAlive() {
	ticker := time.NewTicker(heartbeatEvery)
	defer ticker.Stop()
	for range ticker.C {
		if _, err := h.stdin.Write(h.heartbeat); err != nil {
			return
		}
	}
}

func (h *held) watch(conn *websocket.Conn, ctx context.Context) {
	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()
	for range ticker.C {
		h.mu.Lock()
		current := h.attachedTo(conn)
		h.mu.Unlock()
		if !current {
			return
		}
		pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
		err := conn.Ping(pingCtx)
		cancel()
		if err != nil {
			h.mu.Lock()
			if h.attachedTo(conn) {
				h.detachLocked()
			}
			h.mu.Unlock()
			_ = conn.CloseNow()
			return
		}
	}
}

func (h *held) kill(reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.killLocked(reason)
}

func (h *held) killLocked(reason string) {
	if _, done := h.link.(finished); done {
		return
	}
	if current, ok := h.link.(attached); ok {
		go current.conn.Close(websocket.StatusNormalClosure, reason)
	}
	h.finishLocked()
	// why: pi-env runs each command in its own session, so ending pi-env's group leaves them orphaned; it ends them itself when its stdin ends.
	_ = h.stdin.Close()
	time.AfterFunc(stdinGrace, h.cancel)
}

func (h *held) attach(conn *websocket.Conn, ctx context.Context, have int) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, done := h.link.(finished); done {
		return sessionGone, false
	}
	if have < h.sentBase || have > h.sentBase+len(h.sent) {
		return sessionBehind, false
	}
	switch current := h.link.(type) {
	case attached:
		go current.conn.Close(websocket.StatusNormalClosure, sessionReplace)
	case away:
		current.grace.Stop()
	}
	h.link = attached{conn: conn, ctx: ctx}
	log.Printf("held session attached again; %d messages to resend", h.sentBase+len(h.sent)-have)
	resume, _ := json.Marshal(map[string]int{"received": h.received})
	if err := writeMessage(conn, ctx, message{text: true, data: resume}); err != nil {
		h.detachLocked()
		return "", true
	}
	for _, m := range h.sent[have-h.sentBase:] {
		if err := writeMessage(conn, ctx, m); err != nil {
			h.detachLocked()
			return "", true
		}
	}
	if h.ended != nil {
		go conn.Close(websocket.StatusNormalClosure, *h.ended)
		h.finishLocked()
	}
	return "", true
}

func (h *held) serve(conn *websocket.Conn, ctx context.Context) {
	h.mu.Lock()
	current := h.attachedTo(conn)
	h.mu.Unlock()
	if !current {
		return
	}
	go h.watch(conn, ctx)
	var readErr error
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			readErr = err
			break
		}
		h.mu.Lock()
		if !h.attachedTo(conn) {
			h.mu.Unlock()
			return
		}
		h.received++
		h.mu.Unlock()
		if kind == websocket.MessageText {
			if string(data) == protocol.EndOfInput {
				h.stdin.Close()
			}
			continue
		}
		if _, err := h.stdin.Write(data); err != nil {
			break
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.attachedTo(conn) {
		return
	}
	// why: the phone sends a normal closure only when it means to end the session; a dropped network sends no close frame, and the phone's own reattach closes without a code.
	if websocket.CloseStatus(readErr) == websocket.StatusNormalClosure {
		h.killLocked(sessionGone)
		return
	}
	h.detachLocked()
}

type heldWriter struct {
	prefix []byte
	held   *held
}

func (w heldWriter) Write(data []byte) (int, error) {
	w.held.deliver(message{data: append(slices.Clip(w.prefix), data...)})
	return len(data), nil
}

var errSessionTaken = errors.New(sessionTaken)

func startHeld(id, owner string, cmd *exec.Cmd, cancel context.CancelFunc, heartbeat []byte, tagged bool, conn *websocket.Conn, ctx context.Context) (*held, error) {
	if heldByOther(id, owner) {
		return nil, errSessionTaken
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	session := &held{owner: owner, stdin: stdin, heartbeat: heartbeat, cancel: cancel, link: attached{conn: conn, ctx: ctx}}
	if tagged {
		cmd.Stdout = heldWriter{[]byte{protocol.Stdout}, session}
		cmd.Stderr = heldWriter{[]byte{protocol.Stderr}, session}
	} else {
		cmd.Stdout = heldWriter{nil, session}
		cmd.Stderr = log.Writer()
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	holdSession(id, session)
	if heartbeat != nil {
		go session.keepAlive()
	}
	go func() {
		_ = cmd.Wait()
		_ = endGroup(cmd)
		if tagged {
			exit, _ := json.Marshal(map[string]int{"exit": cmd.ProcessState.ExitCode()})
			session.end(&message{text: true, data: exit}, "")
			return
		}
		session.end(nil, "pi-env exited")
	}()
	return session, nil
}

func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, bool) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return nil, false
	}
	conn.SetReadLimit(32 << 20)
	return conn, true
}

func serveHeld(w http.ResponseWriter, r *http.Request, id string, command func(context.Context) *exec.Cmd, heartbeat []byte, tagged bool, what string) {
	conn, ok := accept(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	session, err := startHeld(id, digest(r.URL.Query().Get("key")), command(ctx), cancel, heartbeat, tagged, conn, r.Context())
	if err != nil {
		cancel()
		status := websocket.StatusInternalError
		if errors.Is(err, errSessionTaken) {
			status = websocket.StatusPolicyViolation
		}
		conn.Close(status, "cannot start "+what+": "+err.Error())
		return
	}
	session.serve(conn, r.Context())
}

func resumable(prefix string, start http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		attach := r.URL.Query().Get("attach")
		if attach == "" {
			start(w, r)
			return
		}
		if !tokenPattern.MatchString(attach) {
			http.Error(w, "bad token", http.StatusBadRequest)
			return
		}
		attachHeld(w, r, prefix+attach)
	}
}

func attachHeld(w http.ResponseWriter, r *http.Request, id string) {
	have, err := strconv.Atoi(r.URL.Query().Get("received"))
	if err != nil || have < 0 {
		http.Error(w, "received count required", http.StatusBadRequest)
		return
	}
	conn, ok := accept(w, r)
	if !ok {
		return
	}
	session := takeSession(id, digest(r.URL.Query().Get("key")))
	if session == nil {
		conn.Close(websocket.StatusPolicyViolation, sessionGone)
		return
	}
	if reason, ok := session.attach(conn, r.Context(), have); !ok {
		conn.Close(websocket.StatusPolicyViolation, reason)
		return
	}
	session.serve(conn, r.Context())
}
