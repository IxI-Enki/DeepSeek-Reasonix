package serve

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"reasonix/internal/base/testenv"
	"reasonix/internal/contract/config"
	"reasonix/internal/platform/gitcmd"
	"reasonix/internal/session/control"
)

func isolateServer(t *testing.T) (url, repoDir string, built *string) {
	t.Helper()
	t.Setenv("REASONIX_HOME", testenv.TempDir(t))
	repoDir = testenv.TempDir(t)
	for _, args := range [][]string{
		{"init", "-q", "-b", "trunk"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base", "--allow-empty"},
		{"checkout", "-qb", "topic"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "topic work", "--allow-empty"},
		{"checkout", "-q", "trunk"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repoDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git unavailable: %v\n%s", err, out)
		}
	}
	repo, err := gitcmd.Open(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	ctrl := control.New(control.Options{WorkspaceRoot: repoDir, WorkspaceRepo: repo})
	t.Cleanup(ctrl.Close)
	replacement := control.New(control.Options{})
	t.Cleanup(replacement.Close)
	var dir string
	s := New(ctrl, NewBroadcaster(), config.ServeConfig{})
	s.AllowWorkspaceSwitch()
	s.buildWorkspaceController = func(_ context.Context, d, _ string) (*control.Controller, error) {
		dir = d
		return replacement, nil
	}
	srv := httptest.NewServer(operatorHandler(s))
	t.Cleanup(srv.Close)
	return srv.URL, repoDir, &dir
}

func gitHead(t *testing.T, dir, ref string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", ref)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func TestIsolateFromTheChosenBranch(t *testing.T) {
	url, repoDir, built := isolateServer(t)
	body, _ := json.Marshal(map[string]any{"isolate": true, "worktree": worktreeSelection{Ref: "refs/heads/topic", SourceRoot: repoDir}})
	resp, err := http.Post(url+"/workspace", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST /workspace = %d %s", resp.StatusCode, out)
	}
	if got, want := gitHead(t, *built, "HEAD"), gitHead(t, repoDir, "topic"); got != want {
		t.Fatalf("the isolated copy is at %s, want the topic branch %s", got, want)
	}
	if trunk := gitHead(t, repoDir, "trunk"); trunk == gitHead(t, *built, "HEAD") {
		t.Fatal("the copy was based on HEAD, not on the chosen branch")
	}
}

func TestIsolateWithoutBaseKeepsTheCommittedHead(t *testing.T) {
	url, repoDir, built := isolateServer(t)
	resp, err := http.Post(url+"/workspace", "application/json", strings.NewReader(`{"isolate":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /workspace = %d", resp.StatusCode)
	}
	if got, want := gitHead(t, *built, "HEAD"), gitHead(t, repoDir, "trunk"); got != want {
		t.Fatalf("the isolated copy is at %s, want HEAD %s", got, want)
	}
}

func TestIsolateWithUnknownBaseIsRefusedWithItsCode(t *testing.T) {
	url, repoDir, built := isolateServer(t)
	body, _ := json.Marshal(map[string]any{"isolate": true, "worktree": worktreeSelection{Ref: "refs/heads/nope", SourceRoot: repoDir}})
	resp, err := http.Post(url+"/workspace", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusConflict || reasonOf(t, out).Code != "workspace.worktree_source_missing" {
		t.Fatalf("POST /workspace = %d %s", resp.StatusCode, out)
	}
	if *built != "" {
		t.Fatalf("a refused base still rebuilt the runtime at %q", *built)
	}
}
