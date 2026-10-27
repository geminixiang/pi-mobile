package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	codeLifetime = 15 * time.Minute
	codeTries    = 5
)

var (
	errNoCode    = errors.New("no pairing code is waiting: run `pi-mobile pair` on this computer")
	errWrongCode = errors.New("wrong pairing code")
	pairingMu    sync.Mutex
)

type pairing struct {
	Hash    string    `json:"hash"`
	Expires time.Time `json:"expires"`
	Tries   int       `json:"tries"`
}

type paired struct {
	Device string    `json:"device"`
	Hash   string    `json:"hash"`
	At     time.Time `json:"at"`
}

func stateDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "mobile")
}

func digest(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func readJSON(path string, into any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, into)
}

func writeJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

func newCode(dir string, now time.Time) (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	code := fmt.Sprintf("%06d", n.Int64())
	pairingMu.Lock()
	defer pairingMu.Unlock()
	return code, writeJSON(filepath.Join(dir, "pairing.json"), pairing{Hash: digest(code), Expires: now.Add(codeLifetime)})
}

func redeem(dir, code, device string, now time.Time) (string, error) {
	pairingMu.Lock()
	defer pairingMu.Unlock()
	path := filepath.Join(dir, "pairing.json")
	var waiting pairing
	if err := readJSON(path, &waiting); err != nil || now.After(waiting.Expires) {
		return "", errNoCode
	}
	if subtle.ConstantTimeCompare([]byte(digest(code)), []byte(waiting.Hash)) != 1 {
		waiting.Tries++
		if waiting.Tries >= codeTries {
			return "", errors.Join(errWrongCode, os.Remove(path))
		}
		return "", errors.Join(errWrongCode, writeJSON(path, waiting))
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	key := hex.EncodeToString(raw)
	var devices []paired
	if err := readJSON(filepath.Join(dir, "paired.json"), &devices); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	devices = append(devices, paired{Device: device, Hash: digest(key), At: now})
	return key, writeJSON(filepath.Join(dir, "paired.json"), devices)
}

func pairedDevices(dir string) ([]paired, error) {
	var devices []paired
	if err := readJSON(filepath.Join(dir, "paired.json"), &devices); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return devices, nil
}

func pairedWith(dir, key string) bool {
	if key == "" {
		return false
	}
	devices, err := pairedDevices(dir)
	if err != nil {
		return false
	}
	hash := []byte(digest(key))
	found := 0
	for _, device := range devices {
		found |= subtle.ConstantTimeCompare(hash, []byte(device.Hash))
	}
	return found == 1
}

func forget(dir string, gone func(paired) bool) (int, error) {
	pairingMu.Lock()
	defer pairingMu.Unlock()
	devices, err := pairedDevices(dir)
	if err != nil {
		return 0, err
	}
	kept := []paired{}
	for _, device := range devices {
		if !gone(device) {
			kept = append(kept, device)
		}
	}
	if len(kept) == len(devices) {
		return 0, nil
	}
	return len(devices) - len(kept), writeJSON(filepath.Join(dir, "paired.json"), kept)
}

func unpair(dir, key string) (bool, error) {
	hash := []byte(digest(key))
	n, err := forget(dir, func(device paired) bool { return subtle.ConstantTimeCompare(hash, []byte(device.Hash)) == 1 })
	return n > 0, err
}
