//go:build linux

package computer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestTheRestoreTokenIsSavedOnAFreshHome(t *testing.T) {
	state := filepath.Join(t.TempDir(), ".pi", "mobile")
	if err := rememberRestoreToken(state, "token"); err != nil {
		t.Fatalf("a home without ~/.pi/mobile should still keep the token: %v", err)
	}
	if saved, err := os.ReadFile(restoreTokenFile(state)); err != nil || string(saved) != "token" {
		t.Fatalf("saved %q, %v", saved, err)
	}
}

func TestTheClipboardOwnerIsReadFromTheSignal(t *testing.T) {
	for _, c := range []struct {
		options map[string]dbus.Variant
		want    selectionOwner
	}{
		{map[string]dbus.Variant{"session_is_owner": dbus.MakeVariant(true), "mime_types": mimeTypes("text/plain")}, ownerUs},
		{map[string]dbus.Variant{"session_is_owner": dbus.MakeVariant(false), "mime_types": mimeTypes()}, ownerNobody},
		{map[string]dbus.Variant{"mime_types": mimeTypes("image/png", "UTF8_STRING")}, ownerOtherText},
		{map[string]dbus.Variant{"mime_types": mimeTypes("text/plain;charset=utf-8")}, ownerOtherText},
		{map[string]dbus.Variant{"mime_types": mimeTypes("image/png")}, ownerOtherNoText},
		{map[string]dbus.Variant{}, ownerNobody},
	} {
		if got := ownerOf(c.options); got != c.want {
			t.Errorf("ownerOf(%v) = %v, want %v", c.options, got, c.want)
		}
	}
}

func mimeTypes(types ...string) dbus.Variant {
	return dbus.MakeVariant(struct{ Types []string }{types})
}
