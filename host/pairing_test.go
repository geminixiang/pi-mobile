package main

import (
	"errors"
	"testing"
	"time"
)

func TestAPairingCodeLetsOneDeviceInOnce(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	code, err := newCode(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	if pairedWith(dir, "") || pairedWith(dir, "guess") {
		t.Fatal("unpaired keys are accepted")
	}
	key, err := redeem(dir, code, "phone", now)
	if err != nil {
		t.Fatal(err)
	}
	if !pairedWith(dir, key) {
		t.Fatal("the key from the code is refused")
	}
	if _, err := redeem(dir, code, "other", now); !errors.Is(err, errNoCode) {
		t.Fatalf("a used code paired again: %v", err)
	}
	second, _ := newCode(dir, now)
	other, err := redeem(dir, second, "laptop", now)
	if err != nil || !pairedWith(dir, other) || !pairedWith(dir, key) {
		t.Fatalf("a second device does not keep both: %v", err)
	}
}

func TestAPairingCodeExpiresAndStopsAfterFiveWrongTries(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	code, _ := newCode(dir, now)
	if _, err := redeem(dir, code, "phone", now.Add(codeLifetime+time.Second)); !errors.Is(err, errNoCode) {
		t.Fatalf("an expired code paired: %v", err)
	}
	code, _ = newCode(dir, now)
	wrong := "000000"
	if code == wrong {
		wrong = "000001"
	}
	for try := 1; try <= codeTries; try++ {
		if _, err := redeem(dir, wrong, "attacker", now); !errors.Is(err, errWrongCode) {
			t.Fatalf("try %d: %v", try, err)
		}
	}
	if _, err := redeem(dir, code, "phone", now); !errors.Is(err, errNoCode) {
		t.Fatalf("the code still works after %d wrong tries: %v", codeTries, err)
	}
}
