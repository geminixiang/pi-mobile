//go:build darwin || linux

package computer

import (
	"syscall"
	"time"
)

func quitProcesses(pids []int) {
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	for _, pid := range pids {
		for syscall.Kill(pid, 0) == nil && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}
