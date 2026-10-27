package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
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

func TestOnlyAnotherDeviceOfTheSameUserGetsIn(t *testing.T) {
	var st status
	st.Self.UserID = 7
	st.Self.TailscaleIPs = []string{"100.100.1.1", "fd7a:115c:a1e0::1"}
	device := func(user int64, tags ...string) whois {
		var who whois
		who.Node.Name = "device.tailnet.ts.net."
		who.Node.Tags = tags
		who.UserProfile.ID = user
		return who
	}
	if err := anotherDeviceOfTheUser("100.100.1.2", device(7), st); err != nil {
		t.Fatalf("the user's phone is refused: %v", err)
	}
	for name, refused := range map[string]struct {
		host string
		who  whois
	}{
		"a program on this computer": {"100.100.1.1", device(7)},
		"another user's device":      {"100.100.1.3", device(8)},
		"a tagged device":            {"100.100.1.4", device(7, "tag:ci")},
		"a device with no user":      {"100.100.1.5", device(0)},
	} {
		if anotherDeviceOfTheUser(refused.host, refused.who, st) == nil {
			t.Errorf("%s gets in", name)
		}
	}
}

func TestUnpairByNameForgetsThatDeviceOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	now := time.Now()
	code, _ := newCode(stateDir(), now)
	phone, _ := redeem(stateDir(), code, "s24.tailnet.ts.net.", now)
	code, _ = newCode(stateDir(), now)
	tablet, _ := redeem(stateDir(), code, "tab.tailnet.ts.net.", now)
	if unpairCommand([]string{"nobody"}) == 0 {
		t.Fatal("an unknown name counts as unpaired")
	}
	if unpairCommand([]string{"s24"}) != 0 || pairedWith(stateDir(), phone) || !pairedWith(stateDir(), tablet) {
		t.Fatal("unpairing s24 by its short name did not forget only s24")
	}
	if unpairCommand([]string{"--all"}) != 0 || pairedWith(stateDir(), tablet) {
		t.Fatal("--all kept a device")
	}
}

func TestPreflightAllowsTheMethodThePhoneAsksFor(t *testing.T) {
	request := httptest.NewRequest(http.MethodOptions, "/unpair", nil)
	request.Header.Set("Origin", "http://localhost")
	request.Header.Set("Access-Control-Request-Method", http.MethodDelete)
	response := httptest.NewRecorder()
	allowOrigin(response, request)
	if allowed := response.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(allowed, http.MethodDelete) {
		t.Fatalf("a WebView DELETE is refused at its preflight: %q", allowed)
	}
}
