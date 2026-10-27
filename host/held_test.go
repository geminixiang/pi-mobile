package main

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func execServer(t *testing.T) *httptest.Server {
	server := httptest.NewServer(resumable("exec:", runCommand))
	t.Cleanup(server.Close)
	return server
}

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
	server := execServer(t)
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
	server := execServer(t)
	token := fmt.Sprintf("%032x", time.Now().UnixNano()+1)
	command := "head -c 15 | od -An -tx1 -v | tr -d ' \\n'"
	first := dial(t, wsURL(server, "/exec?session="+token+"&heartbeat=pi-env&command="+url.QueryEscape(command)))
	stdout, texts, _ := readAll(t, first, 5*time.Second)
	if stdout != "0000000b0600000000000000027b7d" || strings.Join(texts, " ") != `{"exit":0}` {
		t.Fatalf("stdin saw %q, texts %q", stdout, texts)
	}
}

func TestAnUnknownAttachIsRefusedByName(t *testing.T) {
	server := execServer(t)
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
	server := execServer(t)
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
	server := execServer(t)
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
	server := execServer(t)
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
	server := execServer(t)
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

func TestRemovingAPairingEndsEverythingItHasOpen(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	code, _ := newCode(dir, now)
	lost, _ := redeem(dir, code, "lost.tailnet.ts.net.", now)
	code, _ = newCode(dir, now)
	kept, _ := redeem(dir, code, "kept.tailnet.ts.net.", now)
	server := execServer(t)
	lostHeld := fmt.Sprintf("%032x", time.Now().UnixNano())
	keptHeld := fmt.Sprintf("%032x", time.Now().UnixNano()+1)
	lostConn := startHeldSleep(t, server, lostHeld, lost)
	defer lostConn.CloseNow()
	defer startHeldSleep(t, server, keptHeld, kept).CloseNow()
	plain := dial(t, wsURL(server, "/exec?key="+lost+"&command="+url.QueryEscape("echo up; sleep 5")))
	defer plain.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := plain.Read(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := forget(dir, func(device paired) bool { return device.Device == "lost.tailnet.ts.net." }); err != nil {
		t.Fatal(err)
	}
	if n, err := endUnpaired(dir); err != nil || n != 2 {
		t.Fatalf("ended %d of the removed pairing's 2 connections: %v", n, err)
	}
	started := time.Now()
	if _, _, reason := readAll(t, plain, 4*time.Second); !strings.Contains(reason, unpaired) {
		t.Fatalf("the removed pairing's plain command was closed with %q", reason)
	}
	if waited := time.Since(started); waited > 2*time.Second {
		t.Fatalf("the removed pairing's plain command ran on for %v", waited)
	}
	if _, _, reason := readAll(t, lostConn, 3*time.Second); !strings.Contains(reason, unpaired) {
		t.Fatalf("the removed pairing's held session was closed with %q", reason)
	}
	if takeSession("exec:"+lostHeld, digest(lost)) != nil {
		t.Fatal("the removed pairing's held session is still there")
	}
	session := takeSession("exec:"+keptHeld, digest(kept))
	if session == nil {
		t.Fatal("another pairing's session ended with it")
	}
	session.kill()
}

func TestEndingAHeldSessionClosesItsStdinBeforeKillingIt(t *testing.T) {
	server := execServer(t)
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	seen := t.TempDir() + "/stdin-ended"
	command := fmt.Sprintf(`trap "" TERM; echo up; cat >/dev/null; echo yes > %s`, seen)
	conn := dial(t, wsURL(server, "/exec?session="+token+"&key=phone-a&command="+url.QueryEscape(command)))
	defer conn.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	takeSession("exec:"+token, digest("phone-a")).kill()
	waitFor(func() bool { _, err := os.Stat(seen); return err == nil })
	if _, err := os.Stat(seen); err != nil {
		t.Fatal("the command was killed without seeing its stdin end, so pi-env could not end the commands it started")
	}
}

func TestAPhoneThatClosesOnPurposeEndsItsHeldSession(t *testing.T) {
	server := execServer(t)
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	conn := startHeldSleep(t, server, token, "phone-a")
	if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(func() bool { return takeSession("exec:"+token, digest("phone-a")) == nil })
	if takeSession("exec:"+token, digest("phone-a")) != nil {
		t.Fatal("a normal closure left the session held")
	}
}

func TestStartingAHeldTokenAgainReplacesTheSessionHoldingIt(t *testing.T) {
	server := execServer(t)
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	first := startHeldSleep(t, server, token, "phone-a")
	defer first.CloseNow()
	second := startHeldSleep(t, server, token, "phone-a")
	defer second.CloseNow()
	if _, _, reason := readAll(t, first, 3*time.Second); !strings.Contains(reason, sessionGone) {
		t.Fatalf("the replaced session's phone was answered %q", reason)
	}
	session := takeSession("exec:"+token, digest("phone-a"))
	if session == nil {
		t.Fatal("the new session is not held")
	}
	session.kill()
}
