FROM debian:trixie-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  gnome-shell mutter xdg-desktop-portal xdg-desktop-portal-gnome pipewire wireplumber dbus dbus-user-session \
  gnome-text-editor at-spi2-core python3 python3-dbus fonts-noto-cjk libglib2.0-bin adwaita-icon-theme \
  && rm -rf /var/lib/apt/lists/*
