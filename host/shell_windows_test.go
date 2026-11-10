package main

import (
	"context"
	"strings"
	"testing"
)

func TestLoginShellRunsThePhonesPOSIXCommands(t *testing.T) {
	if gitBash() == "" {
		t.Skip("Git for Windows is not installed")
	}
	out, err := loginShell(context.Background(), `name="$(printf %s pi)"; [ -n "$HOME" ] && echo "$name-ok" 2>/dev/null`).Output()
	if err != nil {
		t.Fatalf("the phone's commands are POSIX shell, but the host could not run one: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "pi-ok" {
		t.Fatalf("got %q, want pi-ok", got)
	}
}

func TestLoginShellReadsConsoleProgramsAsUTF8(t *testing.T) {
	if gitBash() == "" {
		t.Skip("Git for Windows is not installed")
	}
	out, err := loginShell(context.Background(), `powershell -NoProfile -Command "[char]0x5C08"`).Output()
	if err != nil {
		t.Fatalf("powershell: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "專" {
		t.Fatalf("a console program's Chinese came back as %q: the shell is not on UTF-8", got)
	}
}
