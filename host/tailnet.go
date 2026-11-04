package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"
)

func tailscaleCLI() string {
	if path, err := exec.LookPath("tailscale"); err == nil {
		return path
	}
	for _, path := range []string{"/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

type status struct {
	Self struct {
		UserID       int64    `json:"UserID"`
		DNSName      string   `json:"DNSName"`
		HostName     string   `json:"HostName"`
		TailscaleIPs []string `json:"TailscaleIPs"`
	} `json:"Self"`
	BackendState string `json:"BackendState"`
	Peer         map[string]struct {
		HostName string   `json:"HostName"`
		DNSName  string   `json:"DNSName"`
		OS       string   `json:"OS"`
		Online   bool     `json:"Online"`
		UserID   int64    `json:"UserID"`
		Tags     []string `json:"Tags"`
	} `json:"Peer"`
}

func tailscaleJSON(ctx context.Context, out any, args ...string) error {
	cli := tailscaleCLI()
	if cli == "" {
		return errors.New("tailscale command not found")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Env = append(os.Environ(), "TAILSCALE_BE_CLI=1")
	data, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("tailscale %s: %w", args[0], err)
	}
	return json.Unmarshal(data, out)
}

var selfCache struct {
	sync.Mutex
	at time.Time
	st status
}

func self(ctx context.Context) (status, error) {
	selfCache.Lock()
	defer selfCache.Unlock()
	if time.Since(selfCache.at) < 10*time.Second {
		return selfCache.st, nil
	}
	st, err := selfNow(ctx)
	if err == nil {
		selfCache.at, selfCache.st = time.Now(), st
	}
	return st, err
}

func selfNow(ctx context.Context) (status, error) {
	var st status
	if err := tailscaleJSON(ctx, &st, "status", "--json", "--peers=false"); err != nil {
		return st, err
	}
	if st.BackendState != "Running" {
		return st, fmt.Errorf("tailscale is %s", st.BackendState)
	}
	return st, nil
}

type whois struct {
	Node struct {
		Name string   `json:"Name"`
		Tags []string `json:"Tags"`
	} `json:"Node"`
	UserProfile struct {
		ID        int64  `json:"ID"`
		LoginName string `json:"LoginName"`
	} `json:"UserProfile"`
}

func owner(ctx context.Context, remoteAddr string) (string, error) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return "", err
	}
	var who whois
	if err := tailscaleJSON(ctx, &who, "whois", "--json", host); err != nil {
		return "", err
	}
	st, err := self(ctx)
	if err != nil {
		return "", err
	}
	return who.Node.Name, anotherDeviceOfTheUser(host, who, st)
}

func anotherDeviceOfTheUser(host string, who whois, st status) error {
	if slices.Contains(st.Self.TailscaleIPs, host) {
		return errors.New("the request comes from this computer itself")
	}
	if mine(who.UserProfile.ID, who.Node.Tags, st) {
		return nil
	}
	if len(who.Node.Tags) > 0 {
		return fmt.Errorf("%s is a tagged device", who.Node.Name)
	}
	return fmt.Errorf("%s belongs to %s, not to this computer's user", who.Node.Name, who.UserProfile.LoginName)
}

func mine(user int64, tags []string, st status) bool {
	return len(tags) == 0 && user != 0 && user == st.Self.UserID
}

func tailnetPeers(ctx context.Context) ([]map[string]string, error) {
	var st status
	if err := tailscaleJSON(ctx, &st, "status", "--json"); err != nil {
		return nil, err
	}
	out := []map[string]string{}
	for _, peer := range st.Peer {
		os := map[string]string{"macOS": "darwin", "linux": "linux"}[peer.OS]
		if !peer.Online || os == "" || !mine(peer.UserID, peer.Tags, st) {
			continue
		}
		out = append(out, map[string]string{"name": peer.HostName, "dnsName": strings.TrimSuffix(peer.DNSName, "."), "os": os})
	}
	return out, nil
}

func ipv4s(st status) []string {
	return slices.DeleteFunc(slices.Clone(st.Self.TailscaleIPs), func(ip string) bool { return strings.Contains(ip, ":") })
}

func listen() net.Listener {
	for ; ; time.Sleep(5 * time.Second) {
		st, err := self(context.Background())
		if err != nil {
			log.Printf("waiting for Tailscale: %v", err)
			continue
		}
		for _, ip := range ipv4s(st) {
			ln, err := net.Listen("tcp", net.JoinHostPort(ip, port))
			if err != nil {
				log.Printf("listen %s: %v", ip, err)
				continue
			}
			log.Printf("pi-mobile %s listening on %s (%s)", version, ln.Addr(), strings.TrimSuffix(st.Self.DNSName, "."))
			return ln
		}
	}
}
