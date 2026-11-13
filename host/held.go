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

	// why: a message counted on a link that just dropped must reach stdin before any message from the link that replaced it, because the phone resends only what the count leaves out.
	input sync.Mutex

	mu       sync.Mutex
	link     link
	grace    *time.Timer
	sent     outbox
	received int
}

func (h *held) attachedTo(conn *websocket.Conn) bool {
	current, ok := h.link.(attached)
	return ok && current.conn == conn
}

func (h *held) apply(next link, effects []effect) {
	h.link = next
	for _, e := range effects {
		switch e := e.(type) {
		case closeLink:
			go e.conn.Close(websocket.StatusNormalClosure, e.reason)
		case release:
			if h.onEnd != nil {
				h.onEnd()
			}
		case stopCommand:
			// why: pi-env runs each command in its own session, so ending pi-env's group leaves them orphaned; it ends them itself when its stdin ends.
			_ = h.stdin.Close()
			time.AfterFunc(stdinGrace, h.cancel)
		case replay:
			h.replay(e)
		}
	}
	h.armGrace()
}

func (h *held) armGrace() {
	until, waiting := graceOf(h.link)
	if !waiting {
		if h.grace != nil {
			h.grace.Stop()
		}
		return
	}
	if h.grace == nil {
		h.grace = time.AfterFunc(time.Until(until), h.expire)
		return
	}
	h.grace.Reset(time.Until(until))
}

func (h *held) expire() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.apply(onExpire(h.link, time.Now()))
}

func (h *held) replay(e replay) {
	log.Printf("held session attached again; %d messages to resend", h.sent.end()-e.have)
	resume, _ := json.Marshal(map[string]int{"received": h.received})
	if err := writeMessage(e.to.conn, e.to.ctx, message{text: true, data: resume}); err != nil {
		h.dropped(e.to.conn)
		return
	}
	for _, m := range h.sent.since(e.have) {
		if err := writeMessage(e.to.conn, e.to.ctx, m); err != nil {
			h.dropped(e.to.conn)
			return
		}
	}
}

func (h *held) dropped(conn *websocket.Conn) {
	if h.attachedTo(conn) {
		log.Printf("held session detached; keeping its command for %s", holdFor)
	}
	h.apply(onDrop(h.link, conn, time.Now().Add(holdFor)))
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
	h.sent.push(m)
	current, attachedNow := h.link.(attached)
	if h.sent.bytes > holdBytes && !attachedNow {
		log.Printf("held session dropped: %d bytes waiting while the phone was away", h.sent.bytes)
		h.apply(onKill(h.link, sessionGone))
		return
	}
	h.sent.trim(holdBytes)
	if attachedNow {
		if err := writeMessage(current.conn, current.ctx, m); err != nil {
			h.dropped(current.conn)
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
	h.apply(onExit(h.link, closing))
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
			h.dropped(conn)
			h.mu.Unlock()
			_ = conn.CloseNow()
			return
		}
	}
}

func (h *held) kill(reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.apply(onKill(h.link, reason))
}

func (h *held) attach(conn *websocket.Conn, ctx context.Context, have int) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	next, effects, refused := onAttach(h.link, attached{conn: conn, ctx: ctx}, have, h.sent)
	if refused != "" {
		return refused, false
	}
	h.apply(next, effects)
	return "", true
}

type taken int

const (
	written taken = iota
	stale
	stdinFailed
)

func (h *held) take(conn *websocket.Conn, kind websocket.MessageType, data []byte) taken {
	h.input.Lock()
	defer h.input.Unlock()
	h.mu.Lock()
	if !h.attachedTo(conn) {
		h.mu.Unlock()
		return stale
	}
	h.received++
	h.mu.Unlock()
	if kind == websocket.MessageText {
		if string(data) == protocol.EndOfInput {
			h.stdin.Close()
		}
		return written
	}
	if _, err := h.stdin.Write(data); err != nil {
		return stdinFailed
	}
	return written
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
		outcome := h.take(conn, kind, data)
		if outcome == stale {
			return
		}
		if outcome == stdinFailed {
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
		h.apply(onKill(h.link, sessionGone))
		return
	}
	h.dropped(conn)
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
