package permission

import (
	"encoding/json"
	"testing"
)

func TestGitListingsAreReadOnlyAndTheirWriteFormsAreNot(t *testing.T) {
	for command, want := range map[string]bool{
		"git merge-base main HEAD":      true,
		"git branch --list":             true,
		"git remote -v":                 true,
		"git config --get user.name":    true,
		"git stash list":                true,
		"git branch new":                false,
		"git remote add o u":            false,
		"git config user.name x":        false,
		"git stash pop":                 false,
		"git branch -a && git branch x": false,
	} {
		args, _ := json.Marshal(map[string]any{"command": command})
		if got := BashCommandIsReadOnly(args); got != want {
			t.Errorf("BashCommandIsReadOnly(%q) = %v, want %v", command, got, want)
		}
	}
}
