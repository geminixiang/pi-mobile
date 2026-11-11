#!/bin/sh
export XDG_RUNTIME_DIR=/tmp/xdg XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME
rm -rf /run/systemd/seats /run/dbus/pid /tmp/.X*-lock /tmp/.X11-unix /tmp/xdg /tmp/ready
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
mkdir -p -m 1777 /tmp/.X11-unix
mkdir -p /run/dbus && dbus-daemon --system --fork
exec dbus-run-session -- sh /work/desktop.sh
