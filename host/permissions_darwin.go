package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

var permissions = []permission{
	{"desktop", "取用「桌面」", "系統設定 › 隱私權與安全性 › 檔案與檔案夾", readable("Desktop")},
	{"documents", "取用「文件」", "系統設定 › 隱私權與安全性 › 檔案與檔案夾", readable("Documents")},
	{"downloads", "取用「下載項目」", "系統設定 › 隱私權與安全性 › 檔案與檔案夾", readable("Downloads")},
	{"automation", "控制「System Events」", "系統設定 › 隱私權與安全性 › 自動化", func(string) error {
		return exec.Command("osascript", "-e", `tell application "System Events" to get name of first process`).Run()
	}},
	{"accessibility", "輔助使用", "系統設定 › 隱私權與安全性 › 輔助使用", func(string) error {
		if !requestAccessibility(3 * time.Minute) {
			return errors.New("not granted")
		}
		return nil
	}},
	{"screen", "錄製螢幕", "系統設定 › 隱私權與安全性 › 螢幕與系統錄音", func(string) error {
		requestScreenCapture()
		file := filepath.Join(os.TempDir(), "pi-mobile-screen-check.png")
		defer os.Remove(file)
		if err := exec.Command("screencapture", "-x", file).Run(); err != nil {
			return err
		}
		if info, err := os.Stat(file); err != nil || info.Size() == 0 {
			return errors.New("no image")
		}
		return nil
	}},
}

func readable(folder string) func(home string) error {
	return func(home string) error {
		_, err := os.ReadDir(filepath.Join(home, folder))
		return err
	}
}
