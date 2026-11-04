package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"time"
)

type permission struct {
	key      string
	label    string
	fix      string
	settings string
	check    func(home string) error
}

func permissionsFile() string {
	return filepath.Join(stateDir(), "permissions.json")
}

func askPermissions() {
	home, _ := os.UserHomeDir()
	go func() {
		answers := map[string]bool{}
		for _, p := range permissions {
			answers[p.key] = p.check(home) == nil
			if err := writeJSON(permissionsFile(), answers); err != nil {
				log.Printf("permissions: %v", err)
			}
		}
	}()
}

func readPermissions() map[string]bool {
	answers := map[string]bool{}
	if readJSON(permissionsFile(), &answers) != nil {
		return nil
	}
	return answers
}

const launchLabel = "dev.pi-mobile"

func walkPermissions() {
	if len(permissions) == 0 {
		return
	}
	fmt.Println("\n允許權限：Mac 會一個一個問，都按「允許」")
	missing := []permission{}
	for _, p := range permissions {
		if awaitPermission(p) {
			fmt.Printf("\033[2K  ✓ %s\n", p.label)
			continue
		}
		missing = append(missing, p)
	}
	if screen := slices.IndexFunc(missing, func(p permission) bool { return p.key == "screen" }); screen >= 0 && retryScreen(missing[screen]) {
		missing = slices.Delete(missing, screen, screen+1)
	}
	for _, p := range missing {
		fmt.Printf("  ✗ %s：還沒允許，Bot 用到時會失敗。到 %s 打開 pi-mobile，再執行一次這個安裝指令\n", p.label, p.fix)
	}
}

func awaitPermission(p permission) bool {
	for waited := 0; waited < 200; waited++ {
		if granted, asked := readPermissions()[p.key]; asked {
			return granted
		}
		if waited == 3 {
			hint := p.label
			if p.key == "accessibility" {
				hint = "輔助使用：在跳出的設定裡把 pi-mobile 打開"
			}
			fmt.Printf("  … %s\r", hint)
		}
		if waited == 20 && p.key == "accessibility" {
			openSettings(p)
		}
		time.Sleep(time.Second)
	}
	return false
}

func retryScreen(p permission) bool {
	tty, err := os.Open("/dev/tty")
	if err != nil {
		return false
	}
	defer tty.Close()
	openSettings(p)
	fmt.Print("\033[2K  … 錄製螢幕：在打開的設定裡把 pi-mobile 打開，回到這裡按 Enter")
	_, _ = bufio.NewReader(tty).ReadString('\n')
	if err := exec.Command("launchctl", "kickstart", "-k", "gui/"+strconv.Itoa(os.Getuid())+"/"+launchLabel).Run(); err != nil {
		log.Printf("restart pi-mobile: %v", err)
	}
	for waited := 0; waited < 30; waited++ {
		if granted, asked := readPermissions()[p.key]; asked {
			fmt.Print("\033[2K\r")
			if granted {
				fmt.Printf("  ✓ %s\n", p.label)
			}
			return granted
		}
		time.Sleep(time.Second)
	}
	fmt.Print("\033[2K\r")
	return false
}

func openSettings(p permission) {
	if err := exec.Command("open", p.settings).Run(); err != nil {
		log.Printf("open %s: %v", p.settings, err)
	}
}
