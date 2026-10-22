// pi-host: lets pi mobile operate this computer over the tailnet, as the user who runs it.
//
// It listens on this computer's Tailscale IPv4 address only, never on the LAN, and accepts a request only from a device
// of the same Tailscale user as this computer (`tailscale whois`; tagged devices have no user and are refused), and
// only from the pi app or a non-browser client: a web page in a browser on one of the user's devices has another
// Origin. There is no password or key; the tailnet is the authentication, as Tailscale Serve and tsnet apps use it.
//
// The phone brings the pi-env daemon (docs/design/computer-host.md):
//
//	GET  /info               this computer: os, arch, user, home, name, and the daemons it has
//	PUT  /daemon/<sha256>    store a daemon; refused unless its bytes hash to <sha256>
//	GET  /env?daemon=<sha256>&token=<hex>   WebSocket: runs `pi-env serve --token <hex>` in a login shell from home
//	                          and copies its stdin and stdout as binary messages
//	GET  /exec?command=<sh>  WebSocket: runs a command in a login shell from home, for driving a container engine.
//	                          Binary messages in are stdin, a text "eof" closes it; out, binary messages start with
//	                          1 (stdout) or 2 (stderr), and a last text message {"exit": code} precedes the close.
//	                          It grants nothing /env does not: both run what the user's own device asks, as the user.
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
	"time"

	"github.com/coder/websocket"
)

const port = "4790"

var version = "dev"

var (
	shaPattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	tokenPattern = regexp.MustCompile(`^[0-9a-f]{16,128}$`)
	// The pi app's WebView; requests without an Origin come from programs, not web pages.
	allowedOrigins = map[string]bool{"http://localhost": true, "https://localhost": true, "capacitor://localhost": true}
)

// tailscaleCLI finds the Tailscale command line: on PATH, or inside the macOS app (launchd's PATH has neither).
func tailscaleCLI() string {
	if path, err := exec.LookPath("tailscale"); err == nil {
		return path
	}
	for _, path := range []string{"/Applications/Tailscale.app/Contents/MacOS/tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"} {
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
	// The macOS app's binary is the CLI only when it runs in a terminal, which it tells by TERM; launchd sets none.
	if os.Getenv("TERM") == "" {
		cmd.Env = append(os.Environ(), "TERM=dumb")
	}
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

// self is this computer's Tailscale status, asked at most every 10 s: every request needs its user.
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

// owner reports whether the device at remoteAddr belongs to the Tailscale user this computer belongs to.
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
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "host", "daemons")
}

func daemons() []string {
	entries, _ := os.ReadDir(daemonsDir())
	out := []string{}
	for _, entry := range entries {
		if shaPattern.MatchString(entry.Name()) {
			out = append(out, entry.Name())
		}
	}
	return out
}

// guard admits only the user's own devices, from the app or a program.
func guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && !allowedOrigins[origin] {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			log.Printf("refused %s: origin %s", r.RemoteAddr, origin)
			return
		}
		device, err := owner(r.Context(), r.RemoteAddr)
		if err != nil {
			http.Error(w, "not your device: "+err.Error(), http.StatusForbidden)
			log.Printf("refused %s: %v", r.RemoteAddr, err)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		log.Printf("%s %s from %s", r.Method, r.URL.Path, device)
		next(w, r)
	}
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
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
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

// engines lists the container engines the user's shell finds, best first.
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

// loginShell runs a command as the user's terminal would: their shell, its PATH (Homebrew, colima, nvm), from home.
func loginShell(ctx context.Context, command string, args ...string) *exec.Cmd {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	path := `export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin"; `
	cmd := exec.CommandContext(ctx, shell, append([]string{"-l", "-c", path + command}, args...)...)
	cmd.Dir, _ = os.UserHomeDir()
	return cmd
}

func runCommand(w http.ResponseWriter, r *http.Request) {
	command := r.URL.Query().Get("command")
	if command == "" {
		http.Error(w, "command required", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(32 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := loginShell(ctx, command)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		conn.Close(websocket.StatusInternalError, "cannot start the command")
		return
	}
	var writes sync.Mutex
	var copies sync.WaitGroup
	pump := func(tag byte, from io.Reader) {
		defer copies.Done()
		buffer := make([]byte, 256<<10)
		for {
			n, err := from.Read(buffer[1:])
			if n > 0 {
				buffer[0] = tag
				writes.Lock()
				werr := conn.Write(ctx, websocket.MessageBinary, buffer[:n+1])
				writes.Unlock()
				if werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	copies.Add(2)
	go pump(1, stdout)
	go pump(2, stderr)
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
	copies.Wait()
	code := 0
	if err := cmd.Wait(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			code = -1
		}
	}
	message, _ := json.Marshal(map[string]int{"exit": code})
	writes.Lock()
	_ = conn.Write(ctx, websocket.MessageText, message)
	writes.Unlock()
	conn.Close(websocket.StatusNormalClosure, "")
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
	// The Origin was checked in guard.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(32 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// A login shell, so commands find what the user's terminal finds (Homebrew, nvm, ~/.local/bin).
	cmd := loginShell(ctx, `exec "$0" serve --token "$1"`, daemon, token)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = log.Writer()
	if err := cmd.Start(); err != nil {
		conn.Close(websocket.StatusInternalError, "cannot start pi-env")
		return
	}
	var once sync.Once
	done := func(reason string) { once.Do(func() { cancel(); conn.Close(websocket.StatusNormalClosure, reason) }) }
	go func() {
		buffer := make([]byte, 256<<10)
		for {
			n, err := stdout.Read(buffer)
			if n > 0 {
				if werr := conn.Write(ctx, websocket.MessageBinary, buffer[:n]); werr != nil {
					done("")
					return
				}
			}
			if err != nil {
				done("pi-env exited")
				return
			}
		}
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if _, err := stdin.Write(data); err != nil {
			break
		}
	}
	done("")
	stdin.Close()
	_ = cmd.Wait()
}

// askFolders reads the folders macOS protects, so that it asks whether pi-host may right after it is installed, while
// the user is at the computer, rather than later, when a command from the phone would wait on the question until it
// times out. Once answered, macOS does not ask again (until pi-host's binary changes).
func askFolders() {
	if runtime.GOOS != "darwin" {
		return
	}
	home, _ := os.UserHomeDir()
	go func() {
		for _, dir := range []string{"Desktop", "Documents", "Downloads"} {
			_, _ = os.ReadDir(filepath.Join(home, dir))
		}
	}()
}

// listen binds this computer's Tailscale IPv4 address, waiting for Tailscale to come up.
func listen() net.Listener {
	for {
		st, err := self(context.Background())
		if err == nil {
			for _, ip := range st.Self.TailscaleIPs {
				if !strings.Contains(ip, ":") {
					if ln, err := net.Listen("tcp", net.JoinHostPort(ip, port)); err == nil {
						log.Printf("pi-host %s listening on %s (%s)", version, ln.Addr(), strings.TrimSuffix(st.Self.DNSName, "."))
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
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	askFolders()
	mux := http.NewServeMux()
	mux.HandleFunc("/info", guard(info))
	mux.HandleFunc("/daemon/", guard(putDaemon))
	mux.HandleFunc("/env", guard(env))
	mux.HandleFunc("/exec", guard(runCommand))
	for {
		ln := listen()
		server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		err := server.Serve(ln)
		// The address went away (Tailscale restarted or the IP changed): bind again.
		log.Printf("serve: %v", err)
		time.Sleep(2 * time.Second)
	}
}
