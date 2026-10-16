package control

import (
	"os"
	"strings"
	"testing"

	"reasonix/internal/contract/config"
)

func TestSaveNetworkSettingsStoresACustomProxyAndNeverHandsThePasswordBack(t *testing.T) {
	c := permissionRulesController(t)
	in := NetworkSettings{Mode: "custom", Type: "http", Server: " proxy.example.test ", Port: 8080, Username: " alice ", NoProxy: " localhost "}
	if err := c.SaveNetworkSettings(in, "s3cret-pass", false); err != nil {
		t.Fatal(err)
	}
	got := c.NetworkSettings()
	if got.Mode != "custom" || got.Server != "proxy.example.test" || got.Port != 8080 || got.Username != "alice" || got.NoProxy != "localhost" {
		t.Fatalf("settings = %+v", got)
	}
	if !got.HasPassword {
		t.Fatal("a stored password must be reported")
	}
	if strings.Contains(got.Effective, "s3cret-pass") || strings.Contains(got.URL, "s3cret-pass") {
		t.Fatalf("the password leaked into what the editor reads: %+v", got)
	}
}

func TestSaveNetworkSettingsKeepsThePasswordWhenNoneIsGivenAndClearsItOnRequest(t *testing.T) {
	c := permissionRulesController(t)
	in := NetworkSettings{Mode: "custom", Type: "http", Server: "proxy.example.test", Port: 8080, Username: "alice"}
	if err := c.SaveNetworkSettings(in, "s3cret-pass", false); err != nil {
		t.Fatal(err)
	}
	if err := c.SaveNetworkSettings(in, "  ", false); err != nil {
		t.Fatal(err)
	}
	if !c.NetworkSettings().HasPassword {
		t.Fatal("a blank password in the editor must keep the stored one")
	}
	if err := c.SaveNetworkSettings(in, "", true); err != nil {
		t.Fatal(err)
	}
	if c.NetworkSettings().HasPassword {
		t.Fatal("clearing the password left it stored")
	}
}

func TestSaveNetworkSettingsRefusesAProxyThatCannotBeComposedAndWritesNothing(t *testing.T) {
	c := permissionRulesController(t)
	if err := c.SaveNetworkSettings(NetworkSettings{Mode: "off"}, "", false); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(config.UserConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	err = c.SaveNetworkSettings(NetworkSettings{Mode: "custom"}, "", false)
	if err == nil {
		t.Fatal("a custom proxy with no server or URL was accepted")
	}
	after, _ := os.ReadFile(config.UserConfigPath())
	if string(after) != string(before) {
		t.Fatalf("a refused save changed the file:\n%s", after)
	}
}
