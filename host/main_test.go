package main

import (
	"context"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func alive(marker string) int {
	out, _ := exec.Command("pgrep", "-f", marker).Output()
	return len(strings.Fields(string(out)))
}

func waitFor(condition func() bool) {
	deadline := time.Now().Add(5 * time.Second)
	for !condition() && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
}

func TestCancelEndsWhatTheCommandStarted(t *testing.T) {
	marker := fmt.Sprintf("pi-mobile-test-%d", time.Now().UnixNano())
	ctx, cancel := context.WithCancel(context.Background())
	cmd := loginShell(ctx, fmt.Sprintf(`(exec -a %[1]s sleep 300) & (exec -a %[1]s sleep 300)`, marker))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(func() bool { return alive(marker) >= 2 })
	if n := alive(marker); n < 2 {
		t.Fatalf("started %d of 2", n)
	}
	cancel()
	_ = cmd.Wait()
	waitFor(func() bool { return alive(marker) == 0 })
	if n := alive(marker); n > 0 {
		t.Fatalf("%d left running", n)
	}
}

func TestWaitReturnsWhenTheShellExits(t *testing.T) {
	marker := fmt.Sprintf("pi-mobile-test-%d", time.Now().UnixNano())
	cmd := loginShell(context.Background(), fmt.Sprintf(`(exec -a %s sleep 300) & echo started`, marker))
	var out strings.Builder
	cmd.Stdout = &out
	start := time.Now()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	_ = endGroup(cmd)
	if waited := time.Since(start); waited > 15*time.Second {
		t.Fatalf("waited %v", waited)
	}
	if !strings.Contains(out.String(), "started") {
		t.Fatalf("output %q", out.String())
	}
	waitFor(func() bool { return alive(marker) == 0 })
	if n := alive(marker); n > 0 {
		t.Fatalf("%d left running", n)
	}
}

func TestPreflightAllowsEveryMethodThePhoneSends(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete} {
		if !strings.Contains(corsMethods, method) {
			t.Fatalf("a WebView %s is refused at its preflight: %s", method, corsMethods)
		}
	}
}
