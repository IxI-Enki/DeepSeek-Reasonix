package control

import "testing"

func TestPeersSettingsReadTheUserFileAndSaveTheChoice(t *testing.T) {
	c := permissionRulesController(t)
	if c.PeersSettings().Enabled {
		t.Fatal("messages between sessions must be off until the user turns them on")
	}
	if err := c.SavePeersSettings(true); err != nil {
		t.Fatal(err)
	}
	got := c.PeersSettings()
	if !got.Enabled || got.Path == "" {
		t.Fatalf("after saving on: %+v", got)
	}
	if c.PeersEnabled() {
		t.Fatal("a running session decides at start; saving must not switch it on mid-run")
	}
	if err := c.SavePeersSettings(false); err != nil || c.PeersSettings().Enabled {
		t.Fatalf("saving off: %v, %+v", err, c.PeersSettings())
	}
}
