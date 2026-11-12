//go:build !darwin && !linux && !windows

package computer

import "errors"

func newScreen(string) (screen, error) {
	return nil, errors.New("screen control is on macOS, Linux, and Windows only")
}
