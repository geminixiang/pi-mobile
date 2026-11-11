#!/bin/sh
echo "$DBUS_SESSION_BUS_ADDRESS" > /tmp/bus
pipewire >/tmp/pipewire.log 2>&1 &
sleep 1
wireplumber >/tmp/wireplumber.log 2>&1 &
gnome-shell --headless --wayland --unsafe-mode --virtual-monitor 1280x800 >/tmp/shell.log 2>&1 &
sleep 8
touch /tmp/ready
wait
