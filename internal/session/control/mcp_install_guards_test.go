package control

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"reasonix/internal/base/testenv"
	"reasonix/internal/contract/config"
)

func installController(t *testing.T, workspace string) *Controller {
	t.Helper()
	t.Setenv("REASONIX_HOME", testenv.TempDir(t))
	dir := testenv.TempDir(t)
	c := New(Options{SessionDir: dir, SessionPath: filepath.Join(dir, "s.jsonl"), WorkspaceRoot: workspace})
	t.Cleanup(func() {
		c.Close()
		c.autosaveWG.Wait()
	})
	return c
}

func TestInstallMCPServerRefusesWithoutANameAndSaysWhy(t *testing.T) {
	c := installController(t, "")
	got, err := c.InstallMCPServer(config.PluginEntry{Name: "   ", Command: "x"}, MCPScopeUser)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "issue" || got.Action != "retry" || got.Message == "" {
		t.Fatalf("result = %+v, want an issue the user can retry", got)
	}
}

func TestInstallMCPServerRefusesAProjectScopeWithNoProject(t *testing.T) {
	for _, scope := range []MCPScope{MCPScopeProject, MCPScopeLocal} {
		c := installController(t, "")
		got, err := c.InstallMCPServer(config.PluginEntry{Name: "atlas", Command: "x"}, scope)
		if err != nil {
			t.Fatal(err)
		}
		if got.State != "issue" || got.Name != "atlas" {
			t.Fatalf("scope %v: result = %+v, want an issue for atlas", scope, got)
		}
	}
}

func TestInstallMCPServerThatCannotStartLeavesNothingBehind(t *testing.T) {
	c := installController(t, "")
	missing := filepath.Join(testenv.TempDir(t), "no-such-server-binary")
	got, err := c.InstallMCPServer(config.PluginEntry{Name: "ghost", Command: missing}, MCPScopeUser)
	if err != nil {
		t.Fatal(err)
	}
	if got.State == "ready" || got.ToolCount != 0 {
		t.Fatalf("a server that cannot start reported %+v", got)
	}
	if _, err := c.configuredMCPServer("ghost"); err == nil {
		t.Fatal("a failed install persisted the entry")
	}
	again, err := c.InstallMCPServer(config.PluginEntry{Name: "ghost", Command: missing}, MCPScopeUser)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(again.Message, "已经有一个叫") {
		t.Fatalf("the failed name was left behind: %q", again.Message)
	}
}

func TestInstallMCPServerRefusesANameThatIsAlreadyConfigured(t *testing.T) {
	c := installController(t, "")
	path := config.UserConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("[[plugins]]\nname = \"atlas\"\ncommand = \"/bin/true\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := c.InstallMCPServer(config.PluginEntry{Name: "atlas", Command: "/bin/false"}, MCPScopeUser)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "issue" || !strings.Contains(got.Message, "atlas") {
		t.Fatalf("result = %+v, want a refusal that names the existing server", got)
	}
}

func TestImportMCPEntriesKeepsTheConfigEvenWhenTheServerCannotConnect(t *testing.T) {
	c := installController(t, "")
	missing := filepath.Join(testenv.TempDir(t), "no-such-server-binary")
	entry := config.PluginEntry{Name: "imported", Command: missing}
	total, added, updated, connected, failed, skipped, err := c.ImportMCPEntries([]config.PluginEntry{entry})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || added != 1 || updated != 0 {
		t.Fatalf("total/added/updated = %d/%d/%d, want 1/1/0", total, added, updated)
	}
	if connected+failed+skipped != 1 || connected != 0 {
		t.Fatalf("connected/failed/skipped = %d/%d/%d: the one entry cannot connect, so it is failed or skipped", connected, failed, skipped)
	}
	if !slices.Contains(c.ConfiguredMCPNames(), "imported") {
		t.Fatalf("the import was rolled back with the connection: %v", c.ConfiguredMCPNames())
	}
	_, added, _, _, _, _, err = c.ImportMCPEntries([]config.PluginEntry{entry})
	if err != nil || added != 0 {
		t.Fatalf("importing the same entry again added %d (%v), want 0", added, err)
	}
}
