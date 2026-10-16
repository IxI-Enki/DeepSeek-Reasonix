package worktree

import (
	"context"
	"errors"
	"strings"

	"reasonix/internal/platform/gitcmd"
)

// ErrSourceUnknown means the requested ref is no longer an available branch.
var ErrSourceUnknown = errors.New("worktree: source branch is unavailable")

// Source is a local branch or a remote-tracking branch, never a checkout action.
type Source struct {
	Ref     string `json:"ref"`
	Name    string `json:"name"`
	Remote  bool   `json:"remote"`
	Current bool   `json:"current"`
}

// Sources includes branches checked out by other worktrees: they remain valid
// starting points for a new, independently named branch. It never fetches.
func Sources(ctx context.Context, repo gitcmd.Repo) ([]Source, error) {
	list := []Source{}
	if !repo.Valid() {
		return list, nil
	}
	raw, _, err := runGit(ctx, repo.Top(), "for-each-ref", "--sort=refname",
		"--format=%(refname)%00%(HEAD)%00%(symref)", "refs/heads/", "refs/remotes/")
	if err != nil {
		return nil, err
	}
	for line := range strings.SplitSeq(raw, "\n") {
		fields := strings.Split(line, "\x00")
		if len(fields) != 3 || fields[2] != "" {
			continue
		}
		remote := strings.HasPrefix(fields[0], "refs/remotes/")
		name := strings.TrimPrefix(strings.TrimPrefix(fields[0], "refs/heads/"), "refs/remotes/")
		list = append(list, Source{Ref: fields[0], Name: name, Remote: remote, Current: fields[1] == "*"})
	}
	return list, nil
}
