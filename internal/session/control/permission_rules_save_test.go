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

func permissionRulesController(t *testing.T) *Controller {
	t.Helper()
	t.Setenv("REASONIX_HOME", testenv.TempDir(t))
	dir := testenv.TempDir(t)
	c := New(Options{SessionDir: dir, SessionPath: filepath.Join(dir, "s.jsonl")})
	t.Cleanup(func() {
		c.Close()
		c.autosaveWG.Wait()
	})
	return c
}

func TestSavePermissionRulesReplacesTheListsWholesaleAndSkipsBlankRules(t *testing.T) {
	c := permissionRulesController(t)
	first := PermissionLists{Mode: "ask", Allow: []string{"bash(git status)", "read_file"}, Deny: []string{"bash(rm -rf *)"}}
	if err := c.SavePermissionRules(first); err != nil {
		t.Fatal(err)
	}
	if got := c.PermissionRules().PermissionLists; got.Mode != "ask" || !slices.Equal(got.Allow, first.Allow) || !slices.Equal(got.Deny, first.Deny) {
		t.Fatalf("saved = %+v, want %+v", got, first)
	}
	if err := c.SavePermissionRules(PermissionLists{Mode: "ask", Ask: []string{"   ", "web_fetch"}}); err != nil {
		t.Fatal(err)
	}
	got := c.PermissionRules().PermissionLists
	if len(got.Allow) != 0 || len(got.Deny) != 0 || !slices.Equal(got.Ask, []string{"web_fetch"}) {
		t.Fatalf("a second save must replace, not merge: %+v", got)
	}
}

func TestSavePermissionRulesRefusesATypoAndLeavesTheFileAsItWas(t *testing.T) {
	c := permissionRulesController(t)
	kept := PermissionLists{Mode: "ask", Allow: []string{"read_file"}}
	if err := c.SavePermissionRules(kept); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(config.UserConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	for name, in := range map[string]PermissionLists{
		"unknown mode":      {Mode: "bogus", Allow: []string{"read_file"}},
		"unregistered tool": {Mode: "ask", Allow: []string{"nosuchtool"}},
		"malformed rule":    {Mode: "ask", Deny: []string{"bash(("}},
	} {
		err := c.SavePermissionRules(in)
		if err == nil {
			t.Fatalf("%s was accepted", name)
		}
		after, _ := os.ReadFile(config.UserConfigPath())
		if string(after) != string(before) {
			t.Fatalf("%s: a refused save changed the file:\n%s", name, after)
		}
	}
}

func TestSavePermissionRulesKeepsARuleThatWasAlreadyInTheFile(t *testing.T) {
	c := permissionRulesController(t)
	path := config.UserConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("[permissions]\nmode = \"ask\"\nallow = [\"legacytool\"]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := c.SavePermissionRules(PermissionLists{Mode: "ask", Allow: []string{"legacytool"}}); err != nil {
		t.Fatalf("re-saving a rule the file already held was refused: %v", err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "legacytool") {
		t.Fatalf("the existing rule was dropped:\n%s", data)
	}
	if err := c.SavePermissionRules(PermissionLists{Mode: "ask", Allow: []string{"legacytool", "another-unknown"}}); err == nil {
		t.Fatal("a new unknown rule was accepted next to the existing one")
	}
}
