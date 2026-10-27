package main

import (
	"log"
	"sync"
	"time"
)

type connection struct {
	pairing string
	end     func()
}

var (
	liveMu sync.Mutex
	live   = map[*connection]struct{}{}
)

func track(pairing string, end func()) (untrack func()) {
	c := &connection{pairing: pairing, end: end}
	liveMu.Lock()
	live[c] = struct{}{}
	liveMu.Unlock()
	return func() {
		liveMu.Lock()
		delete(live, c)
		liveMu.Unlock()
	}
}

func endConnections(revoked func(pairing string) bool) int {
	liveMu.Lock()
	var ending []*connection
	for c := range live {
		if revoked(c.pairing) {
			ending = append(ending, c)
			delete(live, c)
		}
	}
	liveMu.Unlock()
	for _, c := range ending {
		c.end()
	}
	return len(ending)
}

func endUnpaired(dir string) (int, error) {
	devices, err := pairedDevices(dir)
	if err != nil {
		return 0, err
	}
	paired := map[string]bool{}
	for _, device := range devices {
		paired[device.Hash] = true
	}
	return endConnections(func(pairing string) bool { return !paired[pairing] }), nil
}

func watchPairings(dir string) {
	for range time.Tick(5 * time.Second) {
		n, err := endUnpaired(dir)
		if err != nil {
			log.Printf("pairings: %v", err)
			continue
		}
		if n > 0 {
			log.Printf("a pairing was removed; ended %d of its connections", n)
		}
	}
}
