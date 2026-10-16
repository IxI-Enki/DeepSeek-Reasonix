package shellsafe

import "strings"

// gitBranchFlags are the options of `git branch` that only choose what a
// listing shows; the valued ones take a following word. Any other option, and
// every positional word that is not a listing pattern, is outside the list:
// that is how `git branch name` or `-d` would read as a listing.
var gitBranchFlags = map[string]bool{
	"-l": false, "--list": false, "-a": false, "--all": false, "-r": false, "--remotes": false,
	"-v": false, "-vv": false, "--verbose": false, "--show-current": false, "-i": false, "--ignore-case": false,
	"--no-color": false, "--no-column": false, "--no-abbrev": false,
	"--contains": true, "--no-contains": true, "--merged": true, "--no-merged": true, "--points-at": true,
}

// gitBranchValued are the `--name=value` forms accepted for the same listing.
var gitBranchValued = []string{"--sort=", "--format=", "--color=", "--column=", "--abbrev=", "--contains=", "--no-contains=", "--merged=", "--no-merged=", "--points-at="}

var gitConfigReads = map[string]bool{"--get": true, "--get-all": true}

// gitSecretKeys are substrings (compared case-insensitively) of configuration
// keys that hold credentials or lead to them; reading one is never classified.
var gitSecretKeys = []string{"credential", "extraheader", "token", "password", "insteadof", "signingkey", "secret"}

// gitConfigFlags may accompany a read of the configuration; the valued ones
// take a following word. Naming a file or blob is not among them.
var gitConfigFlags = map[string]bool{
	"--local": false, "--global": false, "--system": false, "--worktree": false, "--show-origin": false,
	"--show-scope": false, "-z": false, "--null": false, "--includes": false, "--no-includes": false,
	"--bool": false, "--int": false, "--path": false, "--bool-or-int": false, "--expiry-date": false,
	"--default": true, "--type": true,
}

// gitReadOnlyCall reports whether fields are a `git` call that reads although
// its subcommand also has write forms (branch, remote, config, stash), and the
// subcommand that serves as its classification. `merge-base` has no write form
// and sits in ReadOnlyPrefixes instead.
func gitReadOnlyCall(fields []string) (sub string, ok bool) {
	if len(fields) < 2 || strings.ToLower(fields[0]) != "git" || hasResolvedSubstitution(fields) {
		return "", false
	}
	sub = strings.ToLower(fields[1])
	args := fields[2:]
	switch sub {
	case "branch":
		ok = gitBranchLists(args)
	case "remote":
		ok = gitRemoteReads(args)
	case "config":
		ok = gitConfigReadsOnly(args)
	case "stash":
		ok = len(args) > 0 && (args[0] == "list" || args[0] == "show") && !hasLongOpt(args, "--output", 5)
	}
	return sub, ok
}

func gitBranchLists(args []string) bool {
	listing, positional := false, 0
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return false
		}
		if !strings.HasPrefix(arg, "-") {
			positional++
			continue
		}
		if valued, listed := gitBranchFlags[arg]; listed {
			if arg == "-l" || arg == "--list" {
				listing = true
			}
			if valued && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		matched := false
		for _, prefix := range gitBranchValued {
			if strings.HasPrefix(arg, prefix) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return positional == 0 || listing
}

func gitRemoteReads(args []string) bool {
	if len(args) == 0 {
		return true
	}
	switch args[0] {
	case "-v", "--verbose":
		return len(args) == 1
	case "show":
		return len(args) > 2 && args[1] == "-n" && gitOperandsOnly(args[2:])
	case "get-url":
		return gitOperandsOnly(args[1:], "--all", "--push")
	}
	return false
}

// gitOperandsOnly accepts the listed flags and plain words, nothing else.
func gitOperandsOnly(args []string, flags ...string) bool {
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") && !hasAnyArg([]string{arg}, flags...) {
			return false
		}
	}
	return true
}

// gitConfigReadsOnly accepts a read of exactly one key. A listing, a regexp or a
// url match would put the whole merged configuration, including the user-level
// files outside the workspace, in front of the model.
func gitConfigReadsOnly(args []string) bool {
	if len(args) > 0 && args[0] == "get" {
		return gitConfigFlagsOnly(args[1:], false)
	}
	return gitConfigFlagsOnly(args, true)
}

func gitConfigFlagsOnly(args []string, needsRead bool) bool {
	read, keys := !needsRead, 0
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if gitConfigReads[arg] {
			read = true
			continue
		}
		if !strings.HasPrefix(arg, "-") {
			keys++
			lower := strings.ToLower(arg)
			for _, secret := range gitSecretKeys {
				if strings.Contains(lower, secret) {
					return false
				}
			}
			continue
		}
		name, _, attached := strings.Cut(arg, "=")
		valued, listed := gitConfigFlags[name]
		if !listed || (!valued && attached) {
			return false
		}
		if valued && !attached {
			i++
		}
	}
	return read && keys == 1
}
