package serve

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reasonix/internal/base/testenv"
	"reasonix/internal/contract/config"
	"reasonix/internal/session/control"
	"reasonix/internal/state/peermail"
)

func peerServer(t *testing.T, peersDir string, name string) *httptest.Server {
	t.Helper()
	dir := testenv.TempDir(t)
	path := filepath.Join(dir, "sessions", name+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	bc := NewBroadcaster()
	opts := control.Options{Sink: bc, Label: name, ModelRef: config.UnconfiguredRef, SessionDir: filepath.Dir(path), SessionPath: path}
	if peersDir != "" {
		opts.Peers = control.PeersOptions{Dir: peersDir}
	}
	ctrl := control.New(opts)
	t.Cleanup(ctrl.Close)
	server := New(ctrl, bc, config.ServeConfig{})
	server.AllowProviderEdit()
	srv := httptest.NewServer(operatorHandler(server))
	t.Cleanup(srv.Close)
	return srv
}

func TestPeerSettingsRoutesReadAndSaveTheUserFileChoice(t *testing.T) {
	t.Setenv("REASONIX_HOME", testenv.TempDir(t))
	srv := peerServer(t, "", "settings")
	res, err := http.Get(srv.URL + "/peers/settings")
	if err != nil {
		t.Fatal(err)
	}
	text, _ := readAll(res)
	res.Body.Close()
	if !strings.Contains(text, `"enabled":false`) {
		t.Fatalf("default = %s, want off", text)
	}
	status, raw := postSide(t, srv.URL+"/peers/settings", map[string]any{"enabled": true})
	if status != http.StatusOK || !strings.Contains(string(raw), `"enabled":true`) {
		t.Fatalf("save = %d %s", status, raw)
	}
	if status, raw := postSide(t, srv.URL+"/peers/settings", map[string]any{}); status != http.StatusBadRequest {
		t.Fatalf("no choice = %d %s", status, raw)
	}
}

func TestPeerHeldRouteRefusesWithItsOwnCodes(t *testing.T) {
	off := peerServer(t, "", "off")
	if status, raw := postSide(t, off.URL+"/peers/held/m-1", map[string]any{"approve": true}); status != http.StatusConflict || !strings.Contains(string(raw), codePeersDisabled) {
		t.Fatalf("off = %d %s", status, raw)
	}
	on := peerServer(t, filepath.Join(testenv.TempDir(t), "peers"), "on")
	if status, raw := postSide(t, on.URL+"/peers/held/m-nope", map[string]any{"approve": true}); status != http.StatusNotFound || !strings.Contains(string(raw), codePeerNotHeld) {
		t.Fatalf("not held = %d %s", status, raw)
	}
	if status, _ := postSide(t, on.URL+"/peers/held/m-nope", map[string]any{}); status != http.StatusBadRequest {
		t.Fatalf("no choice = %d", status)
	}
}

func TestAHeldMessageShowsUpOnTheReceivingServerAndCanBeDecided(t *testing.T) {
	peersDir := filepath.Join(testenv.TempDir(t), "peers")
	b := peerServer(t, peersDir, "beta")
	d, err := peermail.Open(peersDir)
	if err != nil {
		t.Fatal(err)
	}
	var receiver string
	deadline := time.Now().Add(10 * time.Second)
	for receiver == "" && time.Now().Before(deadline) {
		live, _ := d.ListLive(func(peermail.Live) bool { return true })
		if len(live) == 1 {
			receiver = live[0].SessionID
		}
		time.Sleep(50 * time.Millisecond)
	}
	if receiver == "" {
		t.Fatal("the receiving session did not publish itself")
	}
	if err := d.Send(peermail.Message{ID: "m-1", SentAt: time.Now().UTC(), Body: "hello",
		From: peermail.Party{SessionID: "s-0000000000000001", Title: "other"}, To: peermail.Party{SessionID: receiver}}); err != nil {
		t.Fatal(err)
	}
	for time.Now().Before(deadline) {
		res, err := http.Get(b.URL + "/peers")
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := readAll(res)
		res.Body.Close()
		if strings.Contains(raw, `"body":"hello"`) {
			if status, raw := postSide(t, b.URL+"/peers/held/m-1", map[string]any{"approve": false}); status != http.StatusNoContent {
				t.Fatalf("deny = %d %s", status, raw)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("the receiver never held the message")
}
