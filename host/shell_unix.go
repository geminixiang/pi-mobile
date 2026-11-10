//go:build !windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

const executableSuffix = ""

func loginShell(ctx context.Context, command string, args ...string) *exec.Cmd {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	self, _ := os.Executable()
	path := `export PATH="` + filepath.Dir(self) + `:$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin"; `
	cmd := exec.CommandContext(ctx, shell, append([]string{"-l", "-c", path + command}, args...)...)
	cmd.Dir, _ = os.UserHomeDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return endGroup(cmd) }
	cmd.WaitDelay = 5 * time.Second
	return cmd
}

func endGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	group := -cmd.Process.Pid
	err := syscall.Kill(group, syscall.SIGTERM)
	time.AfterFunc(2*time.Second, func() { _ = syscall.Kill(group, syscall.SIGKILL) })
	return err
}

func refused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED)
}

func daemonCommand(ctx context.Context, daemon, token string) *exec.Cmd {
	return loginShell(ctx, `exec "$0" serve --token "$1"`, daemon, token)
}
