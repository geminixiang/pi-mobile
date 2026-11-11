import json
import os
import subprocess
import sys
import threading
import time

import dbus

os.environ.update(XDG_RUNTIME_DIR="/tmp/xdg", XDG_SESSION_TYPE="wayland", XDG_CURRENT_DESKTOP="GNOME", WAYLAND_DISPLAY="wayland-0", DBUS_SESSION_BUS_ADDRESS=open("/tmp/bus").read().strip())
bus = dbus.SessionBus()
SAVED = "SAVED 剪貼簿"
TYPED = 'alpha beta gamma\n0912345678\n\n中文 ok é ☃ "quoted" a--b'
EXPECTED = 'ALPHA beta gamma\n0912345678\n\n中文 ok é ☃ "quoted" a--b!'


def shell(code):
    ok, result = dbus.Interface(bus.get_object("org.gnome.Shell", "/org/gnome/Shell"), "org.gnome.Shell").Eval(code)
    return json.loads(result) if ok and result else None


def screenshot(path):
    dbus.Interface(bus.get_object("org.gnome.Shell.Screenshot", "/org/gnome/Shell/Screenshot"), "org.gnome.Shell.Screenshot").Screenshot(False, False, path)


def clipboard(text=None):
    if text is not None:
        shell(f"imports.gi.St.Clipboard.get_default().set_text(imports.gi.St.ClipboardType.CLIPBOARD, {json.dumps(text)}); null")
        return text
    shell("imports.gi.St.Clipboard.get_default().get_text(imports.gi.St.ClipboardType.CLIPBOARD, (c, t) => { globalThis.piClip = t; }); null")
    time.sleep(0.5)
    return shell("globalThis.piClip")


def frame(wm_class):
    for _ in range(60):
        rects = shell(f"global.get_window_actors().map(a => a.meta_window).filter(w => w.get_wm_class() === {json.dumps(wm_class)}).map(w => {{ const r = w.get_frame_rect(); return [r.x, r.y, r.width, r.height]; }})")
        if rects:
            return rects[0]
        time.sleep(0.5)
    raise SystemExit(f"no {wm_class} window appeared")


def remote(cast_screen=True):
    rd = dbus.Interface(bus.get_object("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop"), "org.gnome.Mutter.RemoteDesktop")
    path = rd.CreateSession()
    session = bus.get_object("org.gnome.Mutter.RemoteDesktop", path)
    session_id = session.Get("org.gnome.Mutter.RemoteDesktop.Session", "SessionId", dbus_interface="org.freedesktop.DBus.Properties")
    stream = None
    cast = dbus.Interface(bus.get_object("org.gnome.Mutter.ScreenCast", "/org/gnome/Mutter/ScreenCast"), "org.gnome.Mutter.ScreenCast")
    if cast_screen:
        stream = dbus.Interface(bus.get_object("org.gnome.Mutter.ScreenCast", cast.CreateSession({"remote-desktop-session-id": session_id})), "org.gnome.Mutter.ScreenCast.Session").RecordMonitor("", {})
    controls = dbus.Interface(session, "org.gnome.Mutter.RemoteDesktop.Session")
    controls.Start()
    time.sleep(1.5)
    controls.NotifyKeyboardKeysym(0xFFE1, True)
    controls.NotifyKeyboardKeysym(0xFFE1, False)
    return controls, stream


def click(controls, stream, x, y):
    for step in range(3):
        controls.NotifyPointerMotionAbsolute(stream, x + step, y)
        time.sleep(0.1)
    controls.NotifyPointerButton(0x110, True)
    time.sleep(0.08)
    controls.NotifyPointerButton(0x110, False)
    time.sleep(0.5)


def allow():
    controls, stream = remote()
    shell("Main.overview.hide(); null")
    x, y, width, _ = frame("xdg-desktop-portal-gnome")
    click(controls, stream, x + width - 74, y + 157)
    click(controls, stream, x + width - 50, y + 23)
    controls.Stop()


class Host:
    def __init__(self):
        self.process = subprocess.Popen(["/work/pi-mobile", "mcp", "computer"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.id = 0
        self.call("initialize", {"protocolVersion": "2025-06-18"})

    def call(self, method, params):
        self.id += 1
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        result = json.loads(self.process.stdout.readline()).get("result", {})
        if result.get("isError"):
            raise SystemExit(f"{params.get('name')} failed: {[part.get('text') for part in result.get('content', [])]}")
        return result

    def act(self, steps):
        return self.call("tools/call", {"name": "act", "arguments": {"steps": steps}})


subprocess.run(["gsettings", "set", "org.gnome.desktop.interface", "enable-hot-corners", "false"], check=True)
permissions = dbus.Interface(bus.get_object("org.freedesktop.impl.portal.PermissionStore", "/org/freedesktop/impl/portal/PermissionStore"), "org.freedesktop.impl.portal.PermissionStore")
permissions.SetPermission("screenshot", True, "screenshot", "", ["yes"])
os.makedirs(os.path.expanduser("~/.pi/mobile"), exist_ok=True)
open("/tmp/probe.txt", "w").close()
subprocess.Popen(["gnome-text-editor", "--standalone", "/tmp/probe.txt"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
frame("org.gnome.TextEditor")
keyboard, _ = remote()
clipboard(SAVED)

host = Host()
approver = threading.Thread(target=allow)
approver.start()
host.call("tools/call", {"name": "screenshot", "arguments": {}})
approver.join()
host.process.terminate()
host.process.wait()
host = Host()
host.call("tools/call", {"name": "screenshot", "arguments": {}})
for _ in range(20):
    if not shell("Main.overview.hide(); Main.overview.visible"):
        break
    time.sleep(0.5)
shell("global.get_window_actors().map(a => a.meta_window).filter(w => w.get_wm_class() === 'org.gnome.TextEditor').forEach(w => w.activate(global.get_current_time())); null")
time.sleep(1)
screenshot("/tmp/before.png")
for _ in range(20):
    ex, ey, ew, eh = frame("org.gnome.TextEditor")
    if ew > 0:
        break
    time.sleep(0.5)
host.act([
    {"action": "click", "x": ex + ew // 2, "y": ey + eh // 2},
    {"action": "type", "text": TYPED},
])
keyboard.NotifyKeyboardKeysym(0xFFE3, True)
keyboard.NotifyKeyboardKeysym(0x73, True)
keyboard.NotifyKeyboardKeysym(0x73, False)
keyboard.NotifyKeyboardKeysym(0xFFE3, False)
time.sleep(1.5)
failures = []
typed = open("/tmp/probe.txt").read().rstrip("\n")
if typed != TYPED:
    failures.append(f"typing: the file holds {typed!r}, want {TYPED!r}")
restored = clipboard()
if restored != SAVED:
    failures.append(f"typing: the clipboard holds {restored!r}, want {SAVED!r}")
host.act([
    {"action": "click", "x": ex + 25, "y": ey + 68, "count": 2},
    {"action": "type", "text": "ALPHA"},
    {"action": "key", "keys": "ctrl+end"},
    {"action": "type", "text": "!"},
    {"action": "key", "keys": "ctrl+s"},
    {"action": "wait", "ms": 1000},
])
chorded = open("/tmp/probe.txt").read().rstrip("\n")
if chorded != EXPECTED:
    failures.append(f"a double click and keys after typing: the file holds {chorded!r}, want {EXPECTED!r}")
screenshot("/tmp/wayland.png")
print("\n".join(failures) or "wayland: pasted lines, the restored clipboard, a double click, ctrl chords and saving all came out right")
sys.exit(1 if failures else 0)
