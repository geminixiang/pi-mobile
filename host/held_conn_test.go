package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type trackedConn struct {
	net.Conn
	mu     sync.Mutex
	closed bool
}

func (c *trackedConn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return c.Conn.Close()
}

type trackingListener struct {
	net.Listener
	mu    sync.Mutex
	conns []*trackedConn
}

func (l *trackingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tracked := &trackedConn{Conn: conn}
	l.mu.Lock()
	l.conns = append(l.conns, tracked)
	l.mu.Unlock()
	return tracked, nil
}

func (l *trackingListener) open() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, c := range l.conns {
		c.mu.Lock()
		if !c.closed {
			n++
		}
		c.mu.Unlock()
	}
	return n
}

func dialTCP(t *testing.T, u string) (*websocket.Conn, *net.TCPConn) {
	t.Helper()
	var raw *net.TCPConn
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		if tcp, ok := c.(*net.TCPConn); ok {
			raw = tcp
		}
		return c, err
	}}}
	conn, _, err := websocket.Dial(context.Background(), u, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	return conn, raw
}

// why: a phone whose network goes away sends a reset or nothing, never a close frame, and the computer's Go GC alone did not free those sockets: one host kept 46 of them in CLOSED.
func TestAPhoneThatVanishesLeavesNoOpenConnectionWhileItsSessionIsHeld(t *testing.T) {
	vanish := map[string]func(*websocket.Conn, *net.TCPConn){
		"reset": func(_ *websocket.Conn, raw *net.TCPConn) {
			_ = raw.SetLinger(0)
			_ = raw.Close()
		},
		"fin without a close frame": func(_ *websocket.Conn, raw *net.TCPConn) { _ = raw.Close() },
		"reattach that closes without a code": func(conn *websocket.Conn, _ *net.TCPConn) { _ = conn.CloseNow() },
	}
	for name, drop := range vanish {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewUnstartedServer(resumable("exec:", runCommand))
			listener := &trackingListener{Listener: server.Listener}
			server.Listener = listener
			server.Start()
			t.Cleanup(server.Close)
			token := fmt.Sprintf("%032x", time.Now().UnixNano())
			conn, raw := dialTCP(t, wsURL(server, "/exec?session="+token+"&command="+url.QueryEscape("echo up; sleep 5")))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if _, _, err := conn.Read(ctx); err != nil {
				t.Fatal(err)
			}
			cancel()
			drop(conn, raw)
			waitFor(func() bool { return listener.open() == 0 })
			session := takeSession("exec:"+token, digest(""))
			if session == nil {
				t.Fatal("the session was let go instead of held")
			}
			defer session.kill(sessionGone)
			if n := listener.open(); n != 0 {
				t.Fatalf("%d connection(s) to the vanished phone still open on the computer", n)
			}
		})
	}
}
