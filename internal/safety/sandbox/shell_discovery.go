package sandbox

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ShellDiscovery is one shell resolution and how it may spend time. Zero values
// are the production behaviour; Probe, Budget and Hedge exist so a caller can
// drive discovery through a slow or hung interpreter on any OS.
type ShellDiscovery struct {
	Prefer, Path string
	Warn         io.Writer
	// ProofDir, when set, keeps launch proofs between runs. It must sit in the
	// user's own data tree; a proof never changes a sandbox decision.
	ProofDir string
	// Probe replaces the bash launch probe. The in-process memo is private to this call; proofs still persist to ProofDir.
	Probe  func(string) bool
	Budget time.Duration
	Hedge  time.Duration
}

// Resolve is ResolveShell with the discovery settings above.
func (d ShellDiscovery) Resolve() Shell {
	h := currentHost()
	memo := &provenBash
	if d.Probe != nil {
		memo = new(sync.Map)
	}
	store := newShellProofStore(d.ProofDir)
	h.probe = func(path string) bool {
		run := d.Probe
		if run == nil {
			if runtime.GOOS != "windows" {
				return true
			}
			run = runBashProbe
		}
		return proveBash(path, run, store, memo)
	}
	h.search = &bashSearch{budget: d.Budget, hedge: d.Hedge}
	return resolveOn(h, d.Prefer, d.Path, d.Warn)
}

type bashSearch struct{ budget, hedge time.Duration }

const (
	// bashDiscoveryBudget caps how long discovery waits for every bash candidate
	// together; the unanswered ones are reported as probe_timeout.
	bashDiscoveryBudget = 12 * time.Second
	bashHedgeDelay      = 1500 * time.Millisecond
)

func (s *bashSearch) timing() (budget, hedge time.Duration) {
	budget, hedge = bashDiscoveryBudget, bashHedgeDelay
	if s != nil && s.budget > 0 {
		budget = s.budget
	}
	if s != nil && s.hedge > 0 {
		hedge = s.hedge
	}
	return budget, hedge
}

// bashCandidates lists the bash executables worth proving, best first.
func (h shellHost) bashCandidates() []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if key := strings.ToLower(filepath.Clean(p)); !seen[key] {
			seen[key] = true
			out = append(out, p)
		}
	}
	if p, ok := h.lookShell("bash"); ok && !h.isWSL(p) {
		add(p)
	}
	for _, p := range h.winBash {
		if h.exists(p) && !h.isWSL(p) {
			add(p)
		}
	}
	return out
}

// bash proves the first usable candidate. A candidate that has not answered
// within the hedge delay lets the next one start alongside it, so one hung
// launch does not serialise the rest, and the whole search stops waiting after
// the budget. Preference order decides the winner, never arrival order.
func (h shellHost) bash() (Shell, bool) {
	cands := h.bashCandidates()
	budgetFor, hedgeFor := h.search.timing()
	answers := make([]chan bool, len(cands))
	start := func(i int) {
		if answers[i] != nil {
			return
		}
		c := make(chan bool, 1)
		answers[i] = c
		go func() { c <- h.probe(cands[i]) }()
	}
	budget := time.After(budgetFor)
	next := 0
	for i := range cands {
		start(i)
		next = max(next, i+1)
	wait:
		for {
			var hedge <-chan time.Time
			if next < len(cands) {
				hedge = time.After(hedgeFor)
			}
			select {
			case ok := <-answers[i]:
				if ok {
					return Shell{Kind: ShellBash, Path: cands[i]}, true
				}
				break wait
			case <-hedge:
				start(next)
				next++
			case <-budget:
				return bashAtBudget(cands, answers, i)
			}
		}
	}
	return Shell{}, false
}

// bashAtBudget settles a search that ran out of time: the first candidate from
// i on that already proved itself wins, and every one still unanswered is
// recorded as a timeout.
func bashAtBudget(cands []string, answers []chan bool, i int) (Shell, bool) {
	var won *Shell
	for j := i; j < len(cands); j++ {
		var ok bool
		if answers[j] != nil {
			select {
			case ok = <-answers[j]:
			default:
				bashProbeFailures.Store(cands[j], FallbackProbeTimeout)
				continue
			}
		}
		if ok && won == nil {
			won = &Shell{Kind: ShellBash, Path: cands[j]}
		}
	}
	if won != nil {
		return *won, true
	}
	return Shell{}, false
}

// bashProbeIdentity is the file a successful probe vouched for. The same path
// with the same size and mtime is the same executable, so it is not launched
// again; a failure is never kept, because a timeout may be transient.
type bashProbeIdentity struct {
	path    string
	size    int64
	modTime int64
}

// provenBash lives for the process. It holds successes, and for a short window
// the probes that hung: a bash that exists but never answers costs a probe
// timeout every time it is asked, and nothing about the file changed between
// asks. A probe that exited with a plain failure is cheap to repeat and not kept.
var provenBash sync.Map

// hungProbeMemory is how long a hung probe is not repeated for the same file.
var hungProbeMemory = time.Minute

type hungProbe struct{ at time.Time }

func probeBashMemo(path string, run func(string) bool) bool {
	return proveBash(path, run, nil, &provenBash)
}

// proveBash answers from this process's memo, then from a persisted proof of
// the same bytes, and only then launches the probe. The file's identity is its
// path, size and modification time.
func proveBash(path string, run func(string) bool, store *shellProofStore, memo *sync.Map) bool {
	fi, err := os.Stat(path)
	if err != nil {
		return run(path)
	}
	id := bashProbeIdentity{path: path, size: fi.Size(), modTime: fi.ModTime().UnixNano()}
	if v, ok := memo.Load(id); ok {
		hung, wasHung := v.(hungProbe)
		if !wasHung {
			return true
		}
		if time.Since(hung.at) < hungProbeMemory {
			return false
		}
		memo.Delete(id)
	}
	if store.holds(path, fi) {
		memo.Store(id, struct{}{})
		return true
	}
	digest := ""
	if store != nil {
		digest, _ = digestFile(path)
	}
	if !run(path) {
		if bashProbeTimedOut(path) {
			memo.Store(id, hungProbe{at: time.Now()})
		}
		return false
	}
	memo.Store(id, struct{}{})
	if digest != "" {
		store.record(path, fi, digest)
	}
	return true
}
