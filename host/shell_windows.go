package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

const executableSuffix = ".exe"

func loginShell(ctx context.Context, command string, args ...string) *exec.Cmd {
	shell := os.Getenv("ComSpec")
	if shell == "" {
		shell = `C:\Windows\System32\cmd.exe`
	}
	cmd := exec.CommandContext(ctx, shell)
	// why: cmd.exe parses its own command line, so Go's argument quoting would break the phone's command; /s strips just the outer quotes.
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `/d /s /c "` + command + `"`, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
	return windowsCommand(cmd)
}

func refused(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED)
}

func daemonCommand(ctx context.Context, daemon, token string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, daemon, "serve", "--token", token)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
	return windowsCommand(cmd)
}

func windowsCommand(cmd *exec.Cmd) *exec.Cmd {
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
