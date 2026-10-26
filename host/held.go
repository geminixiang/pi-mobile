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
)

var (
	holdFor        = 5 * time.Minute
	heartbeatEvery = 5 * time.Second
	pingEvery      = 10 * time.Second
	pingTimeout    = 10 * time.Second
	writeTimeout   = 10 * time.Second
)

// why: pi-env's wire format, type 6 (ping) with id 0 and the JSON object {}; it keeps the daemon from exiting after 30 s of silence while the phone is away.
var piEnvPing = []byte{0, 0, 0, 11, 6, 0, 0, 0, 0, 0, 0, 0, 2, '{', '}'}

type message struct {
	text bool
	data []byte
}

// why: a phone that loses its network sends no FIN, so the computer only learns of the loss from a failed write or an unanswered ping; held sessions keep pi-env alive themselves (heartbeat) instead of relying on the phone's pings reaching it.
type held struct {
	owner     string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	heartbeat []byte
	cancel    context.CancelFunc
	onEnd     func()

	mu        sync.Mutex
	conn      *websocket.Conn
	ctx       context.Context
	sent      []message
	sentBase  int
	sentBytes int
	received  int
	ended     *string
	grace     *time.Timer
	killed    bool
}

var (
	heldMu   sync.Mutex
	heldByID = map[string]*held{}
)

func holdSession(id string, session *held) {
	heldMu.Lock()
	defer heldMu.Unlock()
	if previous := heldByID[id]; previous != nil {
		previous.kill()
	}
	heldByID[id] = session
	session.onEnd = func() {
		heldMu.Lock()
		if heldByID[id] == session {
			delete(heldByID, id)
		}
		heldMu.Unlock()
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

func endSessionsOf(owner string) int {
	heldMu.Lock()
	var mine []*held
	for _, session := range heldByID {
		if session.ownedBy(owner) {
			mine = append(mine, session)
		}
	}
	heldMu.Unlock()
	for _, session := range mine {
		session.kill()
	}
	return len(mine)
}

func (h *held) deliver(m message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sent = append(h.sent, m)
	h.sentBytes += len(m.data)
	for h.sentBytes > holdBytes && len(h.sent) > 0 {
		if h.conn == nil {
			log.Printf("held session dropped: %d bytes waiting while the phone was away", h.sentBytes)
			h.killLocked()
			return
		}
		h.sentBytes -= len(h.sent[0].data)
		h.sent = h.sent[1:]
		h.sentBase++
	}
	if h.conn != nil {
		if err := writeMessage(h.conn, h.ctx, m); err != nil {
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
	if h.conn != nil {
		go h.conn.Close(websocket.StatusNormalClosure, closing)
		h.conn = nil
		h.finishLocked()
		return
	}
	if h.grace == nil {
		h.finishLocked()
	}
}

func (h *held) finishLocked() {
	if h.grace != nil {
		h.grace.Stop()
		h.grace = nil
	}
	h.killed = true
	if h.onEnd != nil {
		h.onEnd()
	}
}

func (h *held) detachLocked() {
	if h.conn == nil || h.killed {
		return
	}
	h.conn = nil
	if h.ended != nil {
		h.finishLocked()
		return
	}
	log.Printf("held session detached; keeping its command for %s", holdFor)
	h.grace = time.AfterFunc(holdFor, h.kill)
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
		current := h.conn == conn
		h.mu.Unlock()
		if !current {
			return
		}
		pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
		err := conn.Ping(pingCtx)
		cancel()
		if err != nil {
			h.mu.Lock()
			if h.conn == conn {
				h.detachLocked()
			}
			h.mu.Unlock()
			_ = conn.CloseNow()
			return
		}
	}
}

func (h *held) kill() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.killLocked()
}

func (h *held) killLocked() {
	if h.killed {
		return
	}
	if h.conn != nil {
		go h.conn.Close(websocket.StatusNormalClosure, sessionGone)
		h.conn = nil
	}
	h.finishLocked()
	h.cancel()
}

func (h *held) attach(conn *websocket.Conn, ctx context.Context, have int) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.killed && h.ended == nil {
		return sessionGone, false
	}
	if have < h.sentBase || have > h.sentBase+len(h.sent) {
		return sessionBehind, false
	}
	if h.conn != nil {
		go h.conn.Close(websocket.StatusNormalClosure, sessionReplace)
	}
	if h.grace != nil {
		h.grace.Stop()
		h.grace = nil
	}
	h.conn = conn
	h.ctx = ctx
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
		h.conn = nil
		h.finishLocked()
	}
	return "", true
}

func (h *held) serve(conn *websocket.Conn, ctx context.Context) {
	h.mu.Lock()
	current := h.conn == conn
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
		if h.conn != conn {
			h.mu.Unlock()
			return
		}
		h.received++
		h.mu.Unlock()
		if kind == websocket.MessageText {
			if string(data) == "eof" {
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
	if h.conn != conn {
		return
	}
	// why: the phone sends a normal closure only when it means to end the session; a dropped network sends no close frame, and the phone's own reattach closes without a code.
	if websocket.CloseStatus(readErr) == websocket.StatusNormalClosure {
		h.conn = nil
		h.killLocked()
		return
	}
	h.detachLocked()
}

type heldWriter struct {
	tag  byte
	held *held
}

func (w heldWriter) Write(data []byte) (int, error) {
	w.held.deliver(message{data: append([]byte{w.tag}, data...)})
	return len(data), nil
}

func exitCode(err error, cmd *exec.Cmd) int {
	if errors.Is(err, exec.ErrWaitDelay) {
		return cmd.ProcessState.ExitCode()
	}
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	return -1
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
	session := &held{owner: owner, cmd: cmd, stdin: stdin, heartbeat: heartbeat, cancel: cancel, conn: conn, ctx: ctx}
	var stdout io.ReadCloser
	if tagged {
		cmd.Stdout = heldWriter{1, session}
		cmd.Stderr = heldWriter{2, session}
	} else {
		stdout, err = cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		cmd.Stderr = log.Writer()
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	holdSession(id, session)
	if heartbeat != nil {
		go session.keepAlive()
	}
	if stdout != nil {
		go func() {
			buffer := make([]byte, 256<<10)
			for {
				n, err := stdout.Read(buffer)
				if n > 0 {
					session.deliver(message{data: append([]byte(nil), buffer[:n]...)})
				}
				if err != nil {
					return
				}
			}
		}()
	}
	go func() {
		err := cmd.Wait()
		_ = endGroup(cmd)
		if tagged {
			exit, _ := json.Marshal(map[string]int{"exit": exitCode(err, cmd)})
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
