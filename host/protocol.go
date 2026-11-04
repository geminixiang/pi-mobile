package main

import (
	_ "embed"
	"encoding/json"
)

//go:embed protocol.json
var protocolJSON []byte

type wire struct {
	HoldMinutes int    `json:"holdMinutes"`
	EndOfInput  string `json:"endOfInput"`
	Stdout      byte   `json:"stdout"`
	Stderr      byte   `json:"stderr"`
	Heartbeat   string `json:"heartbeat"`
	// why: pi-env's wire format, type 6 (ping) with id 0 and the JSON object {}; it keeps the daemon from exiting after 30 s of silence while the phone is away.
	PiEnvPing []byte `json:"-"`
}

var protocol = func() wire {
	var p struct {
		wire
		PiEnvPing []int `json:"piEnvPing"`
	}
	if err := json.Unmarshal(protocolJSON, &p); err != nil {
		panic("host/protocol.json: " + err.Error())
	}
	for _, b := range p.PiEnvPing {
		p.wire.PiEnvPing = append(p.wire.PiEnvPing, byte(b))
	}
	return p.wire
}()
