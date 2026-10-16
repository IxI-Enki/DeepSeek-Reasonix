package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reasonix/internal/base/testenv"
)

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	return strings.TrimSpace(gitIn(t, dir, args...))
}

// twoBranches leaves the repository on main with a feature branch holding one
// extra commit, so "based on feature" and "based on HEAD" differ by a file.
func twoBranches(t *testing.T) string {
	t.Helper()
	repo := initRepo(t)
	gitOut(t, repo, "checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(repo, "feature.txt"), []byte("only on feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, repo, "add", "feature.txt")
	gitOut(t, repo, "commit", "-m", "feature work")
	gitOut(t, repo, "checkout", "-")
	return repo
}

func TestCreateFromBranchStartsFromThatBranchNotHead(t *testing.T) {
	requireGit(t)
	repo := twoBranches(t)
	head := gitOut(t, repo, "rev-parse", "HEAD")
	res, err := CreateFrom(context.Background(), opened(t, repo), testenv.TempDir(t), "refs/heads/feature")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(res.WorktreeRoot, "feature.txt")); err != nil {
		t.Fatalf("the worktree lacks the chosen branch's commit: %v", err)
	}
	want := gitOut(t, repo, "rev-parse", "feature")
	if res.Head != want || res.Head == head {
		t.Fatalf("result = %+v, want head %s from feature (HEAD was %s)", res, want, head)
	}
	if got := gitOut(t, res.WorktreeRoot, "rev-parse", "HEAD"); got != want {
		t.Fatalf("worktree HEAD = %s, want %s", got, want)
	}
	if !strings.HasPrefix(res.Branch, "reasonix/delivery-") || gitOut(t, repo, "rev-parse", "feature") != want {
		t.Fatalf("a new branch must carry the work and the chosen branch must not move: %+v", res)
	}
}

func TestCreateFromEmptyBaseIsTheCommittedHead(t *testing.T) {
	requireGit(t)
	repo := twoBranches(t)
	res, err := CreateFrom(context.Background(), opened(t, repo), testenv.TempDir(t), "  ")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(res.WorktreeRoot, "feature.txt")); !os.IsNotExist(err) {
		t.Fatalf("an empty base must mean HEAD, stat err = %v", err)
	}
}

func TestCreateFromUnknownBaseCreatesNothing(t *testing.T) {
	requireGit(t)
	repo := twoBranches(t)
	managed := testenv.TempDir(t)
	branches := gitOut(t, repo, "branch", "--list")
	for _, name := range []string{"nope", "--help", "refs/heads/missing", "feature^", "HEAD~1", "feature\x00x", "-x", "feat*"} {
		_, err := CreateFrom(context.Background(), opened(t, repo), managed, name)
		if !errors.Is(err, ErrSourceUnknown) {
			t.Errorf("base %q: err = %v, want ErrSourceUnknown", name, err)
		}
	}
	if entries, _ := os.ReadDir(managed); len(entries) != 0 {
		t.Fatalf("a refused base left %d entries in managed storage", len(entries))
	}
	if after := gitOut(t, repo, "branch", "--list"); after != branches {
		t.Fatalf("branches changed: %q -> %q", branches, after)
	}
}

func TestCreateFromRemoteTrackingBranch(t *testing.T) {
	requireGit(t)
	repo := twoBranches(t)
	sha := gitOut(t, repo, "rev-parse", "feature")
	gitOut(t, repo, "update-ref", "refs/remotes/origin/release", sha)
	res, err := CreateFrom(context.Background(), opened(t, repo), testenv.TempDir(t), "refs/remotes/origin/release")
	if err != nil {
		t.Fatal(err)
	}
	if res.Head != sha {
		t.Fatalf("result = %+v, want head %s", res, sha)
	}
}

func TestCreateFromBranchCheckedOutElsewhereIsFine(t *testing.T) {
	requireGit(t)
	repo := twoBranches(t)
	other := filepath.Join(testenv.TempDir(t), "other")
	gitOut(t, repo, "worktree", "add", other, "feature")
	if _, err := CreateFrom(context.Background(), opened(t, repo), testenv.TempDir(t), "refs/heads/feature"); err != nil {
		t.Fatalf("a branch held by another worktree is only a starting point: %v", err)
	}
}

func TestCreateFromReportsDirtyOnlyForTheCheckedOutBranch(t *testing.T) {
	requireGit(t)
	repo := twoBranches(t)
	current := gitOut(t, repo, "symbolic-ref", "--short", "HEAD")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("uncommitted\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	same, err := CreateFrom(context.Background(), opened(t, repo), testenv.TempDir(t), "refs/heads/"+current)
	if err != nil {
		t.Fatal(err)
	}
	other, err := CreateFrom(context.Background(), opened(t, repo), testenv.TempDir(t), "refs/heads/feature")
	if err != nil {
		t.Fatal(err)
	}
	if !same.SourceDirty || other.SourceDirty {
		t.Fatalf("dirty: current-branch base=%v, other base=%v; want true,false", same.SourceDirty, other.SourceDirty)
	}
}

func TestCreateFromChecksTheSubdirectoryAgainstTheBase(t *testing.T) {
	requireGit(t)
	repo := twoBranches(t)
	sub := filepath.Join(repo, "app")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, repo, "add", "app")
	gitOut(t, repo, "commit", "-m", "app")
	if _, err := CreateFrom(context.Background(), opened(t, sub), testenv.TempDir(t), "refs/heads/feature"); err == nil || errors.Is(err, ErrSourceUnknown) {
		t.Fatalf("feature has no app/ directory, err = %v", err)
	}
	res, err := CreateFrom(context.Background(), opened(t, sub), testenv.TempDir(t), "")
	if err != nil || !strings.HasSuffix(res.WorkspaceRoot, "app") {
		t.Fatalf("HEAD has app/: %+v %v", res, err)
	}
}
