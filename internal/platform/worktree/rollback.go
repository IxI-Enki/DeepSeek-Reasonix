package worktree

import (
	"context"
	"fmt"
	"strings"

	"reasonix/internal/platform/gitcmd"
)

// DiscardUnpublished rolls back a fresh worktree before any session can use it.
// Published worktrees are durable and must never be passed here.
func DiscardUnpublished(ctx context.Context, repo gitcmd.Repo, result Result) error {
	head, _, err := runGit(ctx, repo, "rev-parse", "--verify", "refs/heads/"+result.Branch)
	if err != nil || strings.TrimSpace(head) != result.Head {
		return fmt.Errorf("unpublished worktree branch changed; retained %s", result.WorktreeRoot)
	}
	if _, _, err := runGit(ctx, repo, "worktree", "remove", "--force", result.WorktreeRoot); err != nil {
		return err
	}
	_, _, err = runGit(ctx, repo, "update-ref", "-d", "refs/heads/"+result.Branch, result.Head)
	return err
}
