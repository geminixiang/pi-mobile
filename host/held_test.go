package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func wsURL(server *httptest.Server, path string) string {
	return "ws" + strings.TrimPrefix(server.URL, "http") + path
}

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func readAll(t *testing.T, conn *websocket.Conn, within time.Duration) (stdout string, texts []string, closeReason string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return stdout, texts, websocket.CloseStatus(err).String() + ":" + closeReasonOf(err)
		}
		if kind == websocket.MessageText {
			texts = append(texts, string(data))
			continue
		}
		if len(data) > 0 && data[0] == 1 {
			stdout += string(data[1:])
		}
	}
}

func closeReasonOf(err error) string {
	var closeErr websocket.CloseError
	if asCloseError(err, &closeErr) {
		return closeErr.Reason
	}
	return err.Error()
}

func TestAHeldCommandOutlivesTheConnectionAndReplaysItsOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	command := "for i in 1 2 3 4 5 6; do echo tick $i; sleep 0.4; done"
	first := dial(t, wsURL(server, "/exec?session="+token+"&command="+url.QueryEscape(command)))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if _, _, err := first.Read(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	_ = first.CloseNow()
	time.Sleep(1200 * time.Millisecond)
	ahead := dial(t, wsURL(server, "/exec?attach="+token+"&received=99"))
	if _, _, reason := readAll(t, ahead, 3*time.Second); !strings.Contains(reason, sessionBehind) {
		t.Fatalf("a count beyond what was sent answered %q", reason)
	}
	second := dial(t, wsURL(server, "/exec?attach="+token+"&received=1"))
	stdout, texts, reason := readAll(t, second, 10*time.Second)
	if strings.Contains(stdout, "tick 1\n") || !strings.Contains(stdout, "tick 2") || !strings.Contains(stdout, "tick 6") {
		t.Fatalf("output after reattach %q", stdout)
	}
	if strings.Join(texts, " ") != `{"received":0} {"exit":0}` {
		t.Fatalf("texts %q (%s)", texts, reason)
	}
}

func TestTheComputerKeepsAHeldPiEnvAliveItself(t *testing.T) {
	previous := heartbeatEvery
	heartbeatEvery = 100 * time.Millisecond
	defer func() { heartbeatEvery = previous }()
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	token := fmt.Sprintf("%032x", time.Now().UnixNano()+1)
	command := "head -c 15 | od -An -tx1 -v | tr -d ' \\n'"
	first := dial(t, wsURL(server, "/exec?session="+token+"&heartbeat=pi-env&command="+url.QueryEscape(command)))
	stdout, texts, _ := readAll(t, first, 5*time.Second)
	if stdout != "0000000b0600000000000000027b7d" || strings.Join(texts, " ") != `{"exit":0}` {
		t.Fatalf("stdin saw %q, texts %q", stdout, texts)
	}
}

func TestAnUnknownAttachIsRefusedByName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	conn := dial(t, wsURL(server, "/exec?attach="+fmt.Sprintf("%032x", 7)+"&received=0"))
	_, _, reason := readAll(t, conn, 3*time.Second)
	if !strings.Contains(reason, sessionGone) {
		t.Fatalf("close %q", reason)
	}
}

func TestAHeldCommandIsKilledAfterTheGrace(t *testing.T) {
	previous := holdFor
	holdFor = 400 * time.Millisecond
	defer func() { holdFor = previous }()
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	marker := fmt.Sprintf("pi-mobile-held-%d", time.Now().UnixNano())
	token := fmt.Sprintf("%032x", time.Now().UnixNano()+2)
	command := fmt.Sprintf("(exec -a %s sleep 300)", marker)
	first := dial(t, wsURL(server, "/exec?session="+token+"&command="+url.QueryEscape(command)))
	waitFor(func() bool { return alive(marker) == 1 })
	_ = first.CloseNow()
	waitFor(func() bool { return alive(marker) == 0 })
	if n := alive(marker); n != 0 {
		t.Fatalf("%d left after the grace", n)
	}
	conn := dial(t, wsURL(server, "/exec?attach="+token+"&received=0"))
	_, _, reason := readAll(t, conn, 3*time.Second)
	if !strings.Contains(reason, sessionGone) {
		t.Fatalf("close %q", reason)
	}
}

func TestAnAttachThatResendsWhatThePhoneLostAndLearnsWhatTheComputerLost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	token := fmt.Sprintf("%032x", time.Now().UnixNano()+3)
	first := dial(t, wsURL(server, "/exec?session="+token+"&command="+url.QueryEscape("cat")))
	for _, line := range []string{"one\n", "two\n"} {
		if err := first.Write(context.Background(), websocket.MessageBinary, []byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, _, _ = first.Read(ctx)
	cancel()
	_ = first.CloseNow()
	time.Sleep(300 * time.Millisecond)
	second := dial(t, wsURL(server, "/exec?attach="+token+"&received=0"))
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	kind, data, err := second.Read(ctx)
	if err != nil || kind != websocket.MessageText || string(data) != `{"received":2}` {
		t.Fatalf("resume handshake %s %q %v", kind, data, err)
	}
	if err := second.Write(ctx, websocket.MessageText, []byte("eof")); err != nil {
		t.Fatal(err)
	}
	stdout, texts, _ := readAll(t, second, 5*time.Second)
	if stdout != "one\ntwo\n" || strings.Join(texts, " ") != `{"exit":0}` {
		t.Fatalf("replayed %q, texts %q", stdout, texts)
	}
	behind := dial(t, wsURL(server, "/exec?attach="+token+"&received=0"))
	if _, _, reason := readAll(t, behind, 3*time.Second); !strings.Contains(reason, sessionGone) {
		t.Fatalf("a finished session answered %q", reason)
	}
}

func asCloseError(err error, target *websocket.CloseError) bool {
	return errors.As(err, target)
}

func startHeldSleep(t *testing.T, server *httptest.Server, token, key string) *websocket.Conn {
	t.Helper()
	conn := dial(t, wsURL(server, "/exec?session="+token+"&key="+key+"&command="+url.QueryEscape("echo up; sleep 5")))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	return conn
}

func TestAHeldSessionAnswersOnlyTheKeyThatStartedIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	first := startHeldSleep(t, server, token, "phone-a")
	_ = first.CloseNow()
	time.Sleep(300 * time.Millisecond)
	other := dial(t, wsURL(server, "/exec?attach="+token+"&received=0&key=phone-b"))
	if _, _, reason := readAll(t, other, 3*time.Second); !strings.Contains(reason, sessionGone) {
		t.Fatalf("another key attaching was answered %q", reason)
	}
	mine := dial(t, wsURL(server, "/exec?attach="+token+"&received=0&key=phone-a"))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	kind, data, err := mine.Read(ctx)
	if err != nil || kind != websocket.MessageText || string(data) != `{"received":0}` {
		t.Fatalf("the starting key could not attach: %v %q", err, data)
	}
	takeSession("exec:"+token, digest("phone-a")).kill()
}

func TestAnotherKeyCannotTakeOverASessionToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	first := startHeldSleep(t, server, token, "phone-a")
	defer first.CloseNow()
	other := dial(t, wsURL(server, "/exec?session="+token+"&key=phone-b&command="+url.QueryEscape("echo taken")))
	if _, _, reason := readAll(t, other, 3*time.Second); !strings.Contains(reason, sessionTaken) {
		t.Fatalf("starting a held token under another key was answered %q", reason)
	}
	session := takeSession("exec:"+token, digest("phone-a"))
	if session == nil {
		t.Fatal("the first key's session was replaced")
	}
	session.kill()
}

func TestUnpairingEndsTheSessionsOfThatKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	kept := fmt.Sprintf("%032x", time.Now().UnixNano())
	ended := fmt.Sprintf("%032x", time.Now().UnixNano()+1)
	keep := startHeldSleep(t, server, kept, "phone-a")
	defer keep.CloseNow()
	revoked := startHeldSleep(t, server, ended, "phone-b")
	defer revoked.CloseNow()
	if n := endSessionsOf(digest("phone-b")); n != 1 {
		t.Fatalf("ended %d sessions of the revoked key", n)
	}
	if takeSession("exec:"+ended, digest("phone-b")) != nil {
		t.Fatal("the revoked key's session is still held")
	}
	session := takeSession("exec:"+kept, digest("phone-a"))
	if session == nil {
		t.Fatal("another key's session ended with it")
	}
	session.kill()
}

func TestAPhoneThatClosesOnPurposeEndsItsHeldSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(runCommand))
	defer server.Close()
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	conn := startHeldSleep(t, server, token, "phone-a")
	if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for takeSession("exec:"+token, digest("phone-a")) != nil {
		if time.Now().After(deadline) {
			t.Fatal("a normal closure left the session held")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
