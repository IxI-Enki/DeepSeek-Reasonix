package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestThePeersSwitchIsWrittenReadBackAndSurvivesAnotherSave(t *testing.T) {
	t.Setenv("REASONIX_HOME", t.TempDir())
	path := UserConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := LoadForEdit(path)
	cfg.SetPeersEnabled(true)
	if err := cfg.SaveTo(path); err != nil {
		t.Fatal(err)
	}
	if !LoadForEdit(path).PeersEnabled() {
		data, _ := os.ReadFile(path)
		t.Fatalf("the choice was not written:\n%s", data)
	}
	other := LoadForEdit(path)
	other.SetWriteLease(true)
	if err := other.SaveTo(path); err != nil {
		t.Fatal(err)
	}
	if !LoadForEdit(path).PeersEnabled() {
		t.Fatal("saving another setting dropped the peers switch")
	}
	off := LoadForEdit(path)
	off.SetPeersEnabled(false)
	if err := off.SaveTo(path); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if LoadForEdit(path).PeersEnabled() {
		t.Fatalf("turning it off left it on:\n%s", data)
	}
}
