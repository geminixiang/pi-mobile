//go:build linux

package main

import (
	"os"
	"testing"
)

func TestTheRestoreTokenIsSavedOnAFreshHome(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := rememberRestoreToken("token"); err != nil {
		t.Fatalf("a home without ~/.pi/mobile should still keep the token: %v", err)
	}
	if saved, err := os.ReadFile(restoreTokenFile()); err != nil || string(saved) != "token" {
		t.Fatalf("saved %q, %v", saved, err)
	}
}
