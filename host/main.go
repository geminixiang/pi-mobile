package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const port = "4790"

var version = "dev"

var (
	shaPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	tokenPattern   = regexp.MustCompile(`^[0-9a-f]{16,128}$`)
	allowedOrigins = map[string]bool{"http://localhost": true, "https://localhost": true, "capacitor://localhost": true}
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

func owner(ctx context.Context, remoteAddr string) (string, error) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return "", err
	}
	var who struct {
		Node struct {
			Name string   `json:"Name"`
			Tags []string `json:"Tags"`
		} `json:"Node"`
		UserProfile struct {
			ID        int64  `json:"ID"`
			LoginName string `json:"LoginName"`
		} `json:"UserProfile"`
	}
	if err := tailscaleJSON(ctx, &who, "whois", "--json", host); err != nil {
		return "", err
	}
	st, err := self(ctx)
	if err != nil {
		return "", err
	}
	if len(who.Node.Tags) > 0 {
		return "", fmt.Errorf("%s is a tagged device", who.Node.Name)
	}
	if who.UserProfile.ID == 0 || who.UserProfile.ID != st.Self.UserID {
		return "", fmt.Errorf("%s belongs to %s, not to this computer's user", who.Node.Name, who.UserProfile.LoginName)
	}
	return who.Node.Name, nil
}

func daemonsDir() string {
	return filepath.Join(stateDir(), "daemons")
}

func daemons() []string {
	out := []string{}
	if _, err := os.Stat(daemonsDir()); err != nil {
		return out
	}
	entries, err := os.ReadDir(daemonsDir())
	if err != nil {
		log.Printf("daemons: %v", err)
		return out
	}
	for _, entry := range entries {
		if shaPattern.MatchString(entry.Name()) {
			out = append(out, entry.Name())
		}
	}
	return out
}

func fromOwner(w http.ResponseWriter, r *http.Request) (string, bool) {
	if origin := r.Header.Get("Origin"); origin != "" && !allowedOrigins[origin] {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		log.Printf("refused %s: origin %s", r.RemoteAddr, origin)
		return "", false
	}
	device, err := owner(r.Context(), r.RemoteAddr)
	if err != nil {
		http.Error(w, "not your device: "+err.Error(), http.StatusForbidden)
		log.Printf("refused %s: %v", r.RemoteAddr, err)
		return "", false
	}
	allowOrigin(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return "", false
	}
	return device, true
}

func allowOrigin(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", r.Header.Get("Access-Control-Request-Method"))
	w.Header().Set("Vary", "Origin")
}

func guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := fromOwner(w, r)
		if !ok {
			return
		}
		// why: Tailscale vouches for the device, not the app; any app on the phone reaches this port through the VPN.
		if !pairedWith(stateDir(), r.URL.Query().Get("key")) {
			http.Error(w, "not paired: run `pi-mobile pair` on this computer and enter the code on the phone", http.StatusUnauthorized)
			log.Printf("refused %s %s from %s: not paired", r.Method, r.URL.Path, device)
			return
		}
		log.Printf("%s %s from %s", r.Method, r.URL.Path, device)
		next(w, r)
	}
}

func pair(w http.ResponseWriter, r *http.Request) {
	device, ok := fromOwner(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	key, err := redeem(stateDir(), r.URL.Query().Get("code"), device, time.Now())
	switch {
	case errors.Is(err, errNoCode):
		http.Error(w, err.Error(), http.StatusGone)
		return
	case errors.Is(err, errWrongCode):
		http.Error(w, errWrongCode.Error(), http.StatusUnprocessableEntity)
		log.Printf("wrong pairing code from %s", device)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("paired with %s", device)
	respond(w, map[string]string{"key": key})
}

func unpairHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "DELETE only", http.StatusMethodNotAllowed)
		return
	}
	key := r.URL.Query().Get("key")
	removed, err := unpair(stateDir(), key)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !removed {
		http.Error(w, "that key was not paired", http.StatusNotFound)
		return
	}
	log.Printf("unpaired a device; ended %d of its sessions", endSessionsOf(digest(key)))
	w.WriteHeader(http.StatusNoContent)
}

func versionOnly(w http.ResponseWriter, r *http.Request) {
	if _, ok := fromOwner(w, r); !ok {
		return
	}
	respond(w, map[string]string{"version": version})
}

func info(w http.ResponseWriter, r *http.Request) {
	st, err := self(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	account, _ := user.Current()
	home, _ := os.UserHomeDir()
	name, _ := os.Hostname()
	if st.Self.HostName != "" {
		name = st.Self.HostName
	}
	respond(w, map[string]any{
		"version": version,
		"os":      runtime.GOOS,
		"arch":    map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH],
		"user":    account.Username,
		"home":    home,
		"name":    name,
		"dnsName": strings.TrimSuffix(st.Self.DNSName, "."),
		"daemons": daemons(),
		"engines": engines(r.Context()),
	})
}

func engines(ctx context.Context) []string {
	names := []string{"docker", "podman", "nerdctl"}
	found := make([]bool, len(names))
	var wait sync.WaitGroup
	for i, name := range names {
		wait.Add(1)
		go func() {
			defer wait.Done()
			found[i] = loginShell(ctx, "command -v "+name+" >/dev/null && "+name+" info >/dev/null 2>&1").Run() == nil
		}()
	}
	wait.Wait()
	out := []string{}
	for i, name := range names {
		if found[i] {
			out = append(out, name)
		}
	}
	return out
}

func loginShell(ctx context.Context, command string, args ...string) *exec.Cmd {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	self, _ := os.Executable()
	path := `export PATH="` + filepath.Dir(self) + `:$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin"; `
	cmd := exec.CommandContext(ctx, shell, append([]string{"-l", "-c", path + command}, args...)...)
	cmd.Dir, _ = os.UserHomeDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return endGroup(cmd) }
	cmd.WaitDelay = 5 * time.Second
	return cmd
}

func endGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	group := -cmd.Process.Pid
	err := syscall.Kill(group, syscall.SIGTERM)
	time.AfterFunc(2*time.Second, func() { _ = syscall.Kill(group, syscall.SIGKILL) })
	return err
}

type taggedWriter struct {
	tag    byte
	conn   *websocket.Conn
	ctx    context.Context
	writes *sync.Mutex
}

func (t taggedWriter) Write(data []byte) (int, error) {
	t.writes.Lock()
	defer t.writes.Unlock()
	if err := t.conn.Write(t.ctx, websocket.MessageBinary, append([]byte{t.tag}, data...)); err != nil {
		return 0, err
	}
	return len(data), nil
}

func runCommand(w http.ResponseWriter, r *http.Request) {
	command := r.URL.Query().Get("command")
	if command == "" {
		http.Error(w, "command required", http.StatusBadRequest)
		return
	}
	if session := r.URL.Query().Get("session"); session != "" {
		if !tokenPattern.MatchString(session) {
			http.Error(w, "bad session token", http.StatusBadRequest)
			return
		}
		var heartbeat []byte
		if r.URL.Query().Get("heartbeat") == "pi-env" {
			heartbeat = piEnvPing
		}
		serveHeld(w, r, "exec:"+session, func(ctx context.Context) *exec.Cmd { return loginShell(ctx, command) }, heartbeat, true, "the command")
		return
	}
	conn, ok := accept(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := loginShell(ctx, command)
	stdin, _ := cmd.StdinPipe()
	var writes sync.Mutex
	cmd.Stdout = taggedWriter{1, conn, ctx, &writes}
	cmd.Stderr = taggedWriter{2, conn, ctx, &writes}
	if err := cmd.Start(); err != nil {
		conn.Close(websocket.StatusInternalError, "cannot start the command")
		return
	}
	go func() {
		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				cancel()
				return
			}
			if kind == websocket.MessageText {
				if string(data) == "eof" {
					stdin.Close()
				}
				continue
			}
			if _, err := stdin.Write(data); err != nil {
				return
			}
		}
	}()
	err := cmd.Wait()
	_ = endGroup(cmd)
	message, _ := json.Marshal(map[string]int{"exit": exitCode(err, cmd)})
	writes.Lock()
	_ = conn.Write(ctx, websocket.MessageText, message)
	writes.Unlock()
	conn.Close(websocket.StatusNormalClosure, "")
}

func peers(w http.ResponseWriter, r *http.Request) {
	var st struct {
		Self struct {
			UserID int64 `json:"UserID"`
		} `json:"Self"`
		Peer map[string]struct {
			HostName string   `json:"HostName"`
			DNSName  string   `json:"DNSName"`
			OS       string   `json:"OS"`
			Online   bool     `json:"Online"`
			UserID   int64    `json:"UserID"`
			Tags     []string `json:"Tags"`
		} `json:"Peer"`
	}
	if err := tailscaleJSON(r.Context(), &st, "status", "--json"); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	out := []map[string]string{}
	for _, peer := range st.Peer {
		os := map[string]string{"macOS": "darwin", "linux": "linux"}[peer.OS]
		if !peer.Online || os == "" || len(peer.Tags) > 0 || peer.UserID != st.Self.UserID {
			continue
		}
		out = append(out, map[string]string{"name": peer.HostName, "dnsName": strings.TrimSuffix(peer.DNSName, "."), "os": os})
	}
	respond(w, out)
}

func respond(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func putDaemon(w http.ResponseWriter, r *http.Request) {
	sha := strings.TrimPrefix(r.URL.Path, "/daemon/")
	if r.Method != http.MethodPut || !shaPattern.MatchString(sha) {
		http.Error(w, "PUT /daemon/<sha256>", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(daemonsDir(), 0o700); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	tmp, err := os.CreateTemp(daemonsDir(), ".upload-*")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmp.Name())
	hash := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, hash), http.MaxBytesReader(w, r.Body, 64<<20))
	tmp.Close()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if hex.EncodeToString(hash.Sum(nil)) != sha {
		http.Error(w, "checksum mismatch", http.StatusBadRequest)
		return
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp.Name(), filepath.Join(daemonsDir(), sha)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func env(w http.ResponseWriter, r *http.Request) {
	sha, token := r.URL.Query().Get("daemon"), r.URL.Query().Get("token")
	if !shaPattern.MatchString(sha) || !tokenPattern.MatchString(token) {
		http.Error(w, "daemon and token required", http.StatusBadRequest)
		return
	}
	daemon := filepath.Join(daemonsDir(), sha)
	if _, err := os.Stat(daemon); err != nil {
		http.Error(w, "no such daemon; PUT it first", http.StatusNotFound)
		return
	}
	serveHeld(w, r, "env:"+token, func(ctx context.Context) *exec.Cmd {
		return loginShell(ctx, `exec "$0" serve --token "$1"`, daemon, token)
	}, piEnvPing, false, "pi-env")
}

type permission struct {
	key   string
	label string
	fix   string
	check func(home string) error
}

var permissions = []permission{
	{"desktop", "取用「桌面」", "系統設定 › 隱私權與安全性 › 檔案與檔案夾", readable("Desktop")},
	{"documents", "取用「文件」", "系統設定 › 隱私權與安全性 › 檔案與檔案夾", readable("Documents")},
	{"downloads", "取用「下載項目」", "系統設定 › 隱私權與安全性 › 檔案與檔案夾", readable("Downloads")},
	{"automation", "控制「System Events」", "系統設定 › 隱私權與安全性 › 自動化", func(string) error {
		return exec.Command("osascript", "-e", `tell application "System Events" to get name of first process`).Run()
	}},
	{"accessibility", "輔助使用", "系統設定 › 隱私權與安全性 › 輔助使用", func(string) error {
		if !requestAccessibility(3 * time.Minute) {
			return errors.New("not granted")
		}
		return nil
	}},
	{"screen", "錄製螢幕", "系統設定 › 隱私權與安全性 › 螢幕與系統錄音", func(string) error {
		requestScreenCapture()
		file := filepath.Join(os.TempDir(), "pi-mobile-screen-check.png")
		defer os.Remove(file)
		if err := exec.Command("screencapture", "-x", file).Run(); err != nil {
			return err
		}
		if info, err := os.Stat(file); err != nil || info.Size() == 0 {
			return errors.New("no image")
		}
		return nil
	}},
}

func readable(folder string) func(home string) error {
	return func(home string) error {
		_, err := os.ReadDir(filepath.Join(home, folder))
		return err
	}
}

func permissionsFile() string {
	return filepath.Join(stateDir(), "permissions.json")
}

func askPermissions() {
	if runtime.GOOS != "darwin" {
		return
	}
	home, _ := os.UserHomeDir()
	go func() {
		answers := map[string]bool{}
		for _, p := range permissions {
			answers[p.key] = p.check(home) == nil
			data, _ := json.Marshal(answers)
			if err := os.WriteFile(permissionsFile(), data, 0o600); err != nil {
				log.Printf("permissions: %v", err)
			}
		}
	}()
}

func readPermissions() map[string]bool {
	data, err := os.ReadFile(permissionsFile())
	if err != nil {
		return nil
	}
	answers := map[string]bool{}
	if json.Unmarshal(data, &answers) != nil {
		return nil
	}
	return answers
}

func listen() net.Listener {
	for {
		st, err := self(context.Background())
		if err == nil {
			for _, ip := range st.Self.TailscaleIPs {
				if !strings.Contains(ip, ":") {
					if ln, err := net.Listen("tcp", net.JoinHostPort(ip, port)); err == nil {
						log.Printf("pi-mobile %s listening on %s (%s)", version, ln.Addr(), strings.TrimSuffix(st.Self.DNSName, "."))
						return ln
					} else {
						log.Printf("listen %s: %v", ip, err)
					}
				}
			}
		} else {
			log.Printf("waiting for Tailscale: %v", err)
		}
		time.Sleep(5 * time.Second)
	}
}

func main() {
	command := ""
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "serve":
		serve()
	case "status":
		os.Exit(printStatus())
	case "version", "--version":
		fmt.Println(version)
	case "pair":
		code, err := newCode(stateDir(), time.Now())
		if err != nil {
			fmt.Fprintf(os.Stderr, "pi-mobile pair: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Pairing code: %s (for %d minutes)\n", code, int(codeLifetime.Minutes()))
	case "mcp":
		if len(os.Args) < 3 || os.Args[2] != "computer" {
			fmt.Fprintln(os.Stderr, "usage: pi-mobile mcp computer")
			os.Exit(2)
		}
		os.Exit(serveComputerMCP())
	default:
		fmt.Fprintln(os.Stderr, "pi-mobile: lets the pi mobile app on your phone operate this computer over Tailscale.\n\nUsage:\n  pi-mobile serve     run (the login item does this)\n  pi-mobile status    whether it answers, and where\n  pi-mobile pair      a one-time code that lets a phone in\n  pi-mobile mcp computer   the screen as an MCP server on stdio (the phone starts it)\n  pi-mobile version")
		if command != "" && command != "help" && command != "--help" && command != "-h" {
			os.Exit(2)
		}
	}
}

func printStatus() int {
	st, err := selfNow(context.Background())
	if err != nil {
		fmt.Printf("Tailscale: %v\n", err)
		return 1
	}
	name := strings.TrimSuffix(st.Self.DNSName, ".")
	for _, ip := range st.Self.TailscaleIPs {
		if strings.Contains(ip, ":") {
			continue
		}
		client := http.Client{Timeout: 5 * time.Second}
		response, err := client.Get("http://" + net.JoinHostPort(ip, port) + "/version")
		for wait := 0; err != nil && errors.Is(err, syscall.ECONNREFUSED) && wait < 15; wait++ {
			time.Sleep(time.Second)
			response, err = client.Get("http://" + net.JoinHostPort(ip, port) + "/version")
		}
		if err != nil {
			fmt.Printf("pi-mobile %s: not answering on %s:%s (%v)\n", version, ip, port, err)
			return 1
		}
		defer response.Body.Close()
		var info struct {
			Version string `json:"version"`
		}
		if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&info) != nil {
			fmt.Printf("pi-mobile: %s:%s answered HTTP %d\n", ip, port, response.StatusCode)
			return 1
		}
		found := "none"
		if names := engines(context.Background()); len(names) > 0 {
			found = strings.Join(names, ", ")
		}
		fmt.Printf("pi-mobile %s is running on %s:%s\nOn the phone, add: %s\nContainer engines: %s\n", info.Version, ip, port, strings.Split(name, ".")[0], found)
		if runtime.GOOS == "darwin" {
			answers := readPermissions()
			for _, p := range permissions {
				granted, asked := answers[p.key]
				switch {
				case !asked:
					fmt.Printf("Permission %s: waiting\n", p.key)
				case granted:
					fmt.Printf("Permission %s: granted\n", p.key)
				default:
					fmt.Printf("Permission %s: denied (%s: %s)\n", p.key, p.label, p.fix)
				}
			}
		}
		return 0
	}
	fmt.Println("Tailscale has no IPv4 address here")
	return 1
}

func serve() {
	if _, err := os.Stat(permissionsFile()); err == nil {
		if err := os.Remove(permissionsFile()); err != nil {
			log.Printf("permissions: %v", err)
		}
	}
	askPermissions()
	mux := http.NewServeMux()
	mux.HandleFunc("/version", versionOnly)
	mux.HandleFunc("/pair", pair)
	mux.HandleFunc("/unpair", guard(unpairHandler))
	mux.HandleFunc("/info", guard(info))
	mux.HandleFunc("/daemon/", guard(putDaemon))
	mux.HandleFunc("/env", guard(resumable("env:", env)))
	mux.HandleFunc("/exec", guard(resumable("exec:", runCommand)))
	mux.HandleFunc("/peers", guard(peers))
	for {
		ln := listen()
		server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		err := server.Serve(ln)
		log.Printf("serve: %v", err)
		time.Sleep(2 * time.Second)
	}
}
