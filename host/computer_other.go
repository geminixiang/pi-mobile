//go:build !darwin

package main

import (
	"errors"
	"time"
)

func newScreen() (screen, error) {
	return nil, errors.New("screen control is only on macOS for now")
}

func requestAccessibility(time.Duration) bool { return false }

func requestScreenCapture() bool { return false }
