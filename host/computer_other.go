//go:build !darwin && !linux && !windows

package main

import "errors"

func newScreen() (screen, error) {
	return nil, errors.New("screen control is on macOS, Linux, and Windows only")
}
