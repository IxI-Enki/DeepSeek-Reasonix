package shellsafe

import "testing"

func TestGitReadOnlyCallsThatAlsoHaveWriteForms(t *testing.T) {
	reads := []string{
		"git merge-base main HEAD", "git merge-base --is-ancestor a b", "git merge-base --fork-point main",
		"git branch", "git branch --list", "git branch -a", "git branch -r", "git branch -vv", "git branch --show-current",
		"git branch --list 'feat/*'", "git branch -a --contains abc123", "git branch --merged main", "git branch --sort=-committerdate",
		"git branch --format='%(refname:short)'", "git branch --no-merged", "git branch -r --list 'origin/*'",
		"git remote", "git remote -v", "git remote show -n origin", "git remote get-url origin", "git remote get-url --all origin",
		"git config --get user.name", "git config --get-all remote.origin.fetch", "git config --show-origin --get user.email", "git config --local --get core.bare", "git config get user.name", "git config --global --get user.name", "git config --system --get core.autocrlf",
		"git config --bool --get core.bare", "git config --default x --get a.b",
		"git stash list", "git stash show", "git stash show -p stash@{1}", "git stash list --oneline",
		"git -C /tmp/repo branch -a",
	}
	for _, command := range reads {
		if _, _, _, ok := ClassifyReadOnlyCommand(command); !ok {
			t.Errorf("%q must be a read", command)
		}
	}
	escapes := []string{
		"git branch newname", "git branch newname abc123", "git branch -d old", "git branch -D old", "git branch -m old new", "git branch -M new",
		"git branch -c a b", "git branch -f x HEAD", "git branch --set-upstream-to=origin/x", "git branch -u origin/x", "git branch --unset-upstream",
		"git branch --edit-description", "git branch --delete old", "git branch --move a b", "git branch --track x origin/x", "git branch -av", "git branch --unknown",
		"git branch -- name",
		"git remote show origin", "git remote show", "git remote show -n", "git remote show -n origin extra --evil",
		"git config --list", "git config -l", "git config --global --list", "git config --system -l", "git config list", "git config --get-regexp '^remote'", "git config --get-urlmatch http.extraheader https://x",
		"git config --get user.name user.email", "git config --get", "git config get", "git config --name-only --get a.b",
		"git config --get credential.helper", "git config --get remote.origin.url.insteadOf", "git config --get http.https://x/.extraheader", "git config --get user.signingkey",
		"git config --get GitHub.Token", "git config get credential.https://x.password", "git config --global --get url.https://tok@x/.insteadOf", "git config --get my.secret",
		"git remote add o url", "git remote remove o", "git remote rm o", "git remote rename a b", "git remote set-url o u", "git remote set-head o -a",
		"git remote prune o", "git remote update", "git remote set-branches o x", "git remote -v add", "git remote show --evil o",
		"git config user.name Bob", "git config --global user.name Bob", "git config --unset a.b", "git config --add a.b c", "git config -e", "git config --edit",
		"git config --replace-all a.b c", "git config --rename-section a b", "git config --remove-section a", "git config set a b", "git config unset a",
		"git config --file /etc/passwd --list", "git config -f x --get a", "git config --blob HEAD:x --list", "git config", "git config --get --unknown a",
		"git stash", "git stash push", "git stash pop", "git stash apply", "git stash drop", "git stash clear", "git stash save x", "git stash branch b",
		"git stash create", "git stash store abc", "git stash list --output=/tmp/x", "git stash show --output=/tmp/x",
		"git -c core.pager=sh branch", "git --exec-path=/tmp branch -a",
	}
	for _, command := range escapes {
		if base, sub, _, ok := ClassifyReadOnlyCommand(command); ok {
			t.Errorf("%q must not be classified as a read (got %s %s)", command, base, sub)
		}
	}
}
