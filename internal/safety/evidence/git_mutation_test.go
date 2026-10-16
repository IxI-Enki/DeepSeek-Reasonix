package evidence

import "testing"

func TestGitListingsLeaveNoUnprovenMutation(t *testing.T) {
	for command, want := range map[string]string{
		"git branch --list":    MutationNone,
		"git remote -v":        MutationNone,
		"git config --get a.b": MutationNone,
		"git stash list":       MutationNone,
		"git merge-base a b":   MutationNone,
		"git branch -d old":    MutationUnknown,
		"git config a.b c":     MutationUnknown,
		"git stash pop":        MutationUnknown,
		"git remote add o u":   MutationUnknown,
	} {
		if got := bashMutationClass(command); got != want {
			t.Errorf("bashMutationClass(%q) = %q, want %q", command, got, want)
		}
	}
}
