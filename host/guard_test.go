package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func guarded(t *testing.T) (server *httptest.Server, key string, reached *int) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	previous := owner
	owner = func(context.Context, string) (string, error) { return "phone", nil }
	t.Cleanup(func() { owner = previous })
	now := time.Now()
	code, err := newCode(stateDir(), now)
	if err != nil {
		t.Fatal(err)
	}
	key, err = redeem(stateDir(), code, "phone", now)
	if err != nil {
		t.Fatal(err)
	}
	reached = new(int)
	server = httptest.NewServer(guard(func(http.ResponseWriter, *http.Request) { *reached++ }))
	t.Cleanup(server.Close)
	return server, key, reached
}

func statusOf(t *testing.T, server *httptest.Server, key, origin string) int {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/exec?key="+url.QueryEscape(key), nil)
	if err != nil {
		t.Fatal(err)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

func TestOnlyThePairingKeyOpensTheComputer(t *testing.T) {
	server, key, reached := guarded(t)
	for _, wrong := range []string{"", "guess", key + "x"} {
		if got := statusOf(t, server, wrong, ""); got != http.StatusUnauthorized {
			t.Fatalf("key %q: %d", wrong, got)
		}
	}
	if *reached != 0 {
		t.Fatalf("%d requests got through without the key", *reached)
	}
	if got := statusOf(t, server, key, ""); got != http.StatusOK || *reached != 1 {
		t.Fatalf("the paired key: %d, reached %d", got, *reached)
	}
}

func TestAWebPageIsRefusedEvenWithTheKey(t *testing.T) {
	server, key, reached := guarded(t)
	if got := statusOf(t, server, key, "https://evil.example"); got != http.StatusForbidden || *reached != 0 {
		t.Fatalf("a foreign origin: %d, reached %d", got, *reached)
	}
	if got := statusOf(t, server, key, "capacitor://localhost"); got != http.StatusOK || *reached != 1 {
		t.Fatalf("the app's origin: %d, reached %d", got, *reached)
	}
}

func TestSomeoneElsesDeviceIsRefusedEvenWithTheKey(t *testing.T) {
	server, key, reached := guarded(t)
	owner = func(context.Context, string) (string, error) { return "", errors.New("another user") }
	if got := statusOf(t, server, key, ""); got != http.StatusForbidden || *reached != 0 {
		t.Fatalf("another device: %d, reached %d", got, *reached)
	}
}

func TestThePairingFileIsReadableOnlyByItsOwner(t *testing.T) {
	guarded(t)
	file, err := os.Stat(pairedFile(stateDir()))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := os.Stat(filepath.Dir(pairedFile(stateDir())))
	if err != nil {
		t.Fatal(err)
	}
	if file.Mode().Perm() != 0o600 || folder.Mode().Perm() != 0o700 {
		t.Fatalf("file %o, folder %o", file.Mode().Perm(), folder.Mode().Perm())
	}
}
