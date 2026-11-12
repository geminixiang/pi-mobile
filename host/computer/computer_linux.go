package computer

import (
	"errors"
	"os"
	"os/exec"
)

var errNoDesktop = errors.New("no desktop session on this computer: the screen exists only while the user is logged in to a desktop (GNOME, KDE, or an X11 session); tell the user to log in on the computer itself")

func newScreen(state string) (screen, error) {
	adoptDesktopEnvironment()
	switch {
	case os.Getenv("WAYLAND_DISPLAY") != "":
		return newPortalScreen(state)
	case os.Getenv("DISPLAY") != "":
		return newX11Screen(os.Getenv("DISPLAY"))
	}
	return nil, errNoDesktop
}

func adoptDesktopEnvironment() {
	if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
		return
	}
	out, err := exec.Command("systemctl", "--user", "show-environment").Output()
	if err != nil {
		return
	}
	for name, value := range desktopEnvironment(out) {
		os.Setenv(name, value)
	}
}
