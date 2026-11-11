package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

const executableSuffix = ".exe"

var gitBash = sync.OnceValue(func() string {
	for _, dir := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")} {
		bash := filepath.Join(dir, "Git", "bin", "bash.exe")
		if _, err := os.Stat(bash); dir != "" && err == nil {
			return bash
		}
	}
	return ""
})

func loginShell(ctx context.Context, command string, args ...string) *exec.Cmd {
	if bash := gitBash(); bash != "" {
		// why: console programs print in the console's code page (Big5 on Chinese Windows); the phone reads UTF-8
		return windowsCommand(exec.CommandContext(ctx, bash, append([]string{"-c", "chcp.com 65001 >/dev/null 2>&1; " + command}, args...)...))
	}
	shell := os.Getenv("ComSpec")
	if shell == "" {
		shell = `C:\Windows\System32\cmd.exe`
	}
	cmd := exec.CommandContext(ctx, shell)
	// why: cmd.exe parses its own command line, so Go's argument quoting would break the phone's command; /s strips just the outer quotes.
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `/d /s /c "` + command + `"`}
	return windowsCommand(cmd)
}

func refused(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED)
}

func daemonCommand(ctx context.Context, daemon, token string) *exec.Cmd {
	return windowsCommand(exec.CommandContext(ctx, daemon, "serve", "--token", token))
}

func windowsCommand(cmd *exec.Cmd) *exec.Cmd {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW
	self, _ := os.Executable()
	cmd.Env = append(os.Environ(), "PATH="+filepath.Dir(self)+";"+os.Getenv("PATH"))
	cmd.Dir, _ = os.UserHomeDir()
	cmd.Cancel = func() error { return endGroup(cmd) }
	cmd.WaitDelay = 5 * time.Second
	return cmd
}

func endGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
}
