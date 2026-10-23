package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// alive counts the processes whose command line has marker.
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

// What a command started (a server under npx, a job in the background) ends with the phone's connection: the
// cancelled context ends the command's whole process group, not just its shell.
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

// A command that exits but leaves something holding its output does not keep the connection waiting for good, and
// what it left ends.
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
