package evidence

import (
	"encoding/json"
	"slices"
	"testing"

	"reasonix/internal/contract/provider"
)

func recorded(receipts ...Receipt) *Ledger {
	l := NewLedger()
	for _, r := range receipts {
		l.Record(r)
	}
	return l
}

func TestUninspectedWritePathsIsFreshnessPerPath(t *testing.T) {
	write := func(p string) Receipt {
		return Receipt{ToolName: "edit_file", Success: true, Write: true, Mutation: true, Paths: []string{p}}
	}
	read := func(p string) Receipt {
		return Receipt{ToolName: "read_file", Success: true, Read: true, Paths: []string{p}}
	}
	l := recorded(write("a.go"), read("a.go"), write("b.go"), write("c.go"), read("c.go"), write("a.go"))
	// a.go was read, then written again; b.go was never read; c.go was read after its last write.
	got := l.UninspectedWritePaths([]string{"a.go", "b.go", "c.go", "never-written.go", ""})
	if want := []string{"a.go", "b.go"}; !slices.Equal(got, want) {
		t.Fatalf("UninspectedWritePaths = %v, want %v", got, want)
	}
}

func TestUninspectedWritePathsCountsAFailedWriteForNothingAndAShownPathAsSeen(t *testing.T) {
	failed := Receipt{ToolName: "edit_file", Success: false, Write: true, Paths: []string{"x.go"}}
	shown := Receipt{ToolName: "bash", Success: true, Showed: []string{"y.go"}}
	wrote := Receipt{ToolName: "edit_file", Success: true, Write: true, Paths: []string{"y.go"}}
	l := recorded(failed, wrote, shown)
	if got := l.UninspectedWritePaths([]string{"x.go", "y.go"}); len(got) != 0 {
		t.Fatalf("UninspectedWritePaths = %v, want none (x.go never written, y.go shown)", got)
	}
	var nilLedger *Ledger
	if nilLedger.UninspectedWritePaths([]string{"a"}) != nil || recorded().UninspectedWritePaths(nil) != nil {
		t.Fatal("a nil ledger and an empty path list owe nothing")
	}
}

func TestReceiptProgressSummaryCountsOnlySuccessfulWork(t *testing.T) {
	l := recorded(
		Receipt{ToolName: "edit_file", Success: true, Write: true},
		Receipt{ToolName: "bash", Success: true, Mutation: true, Command: "make build"},
		Receipt{ToolName: "bash", Success: false, Command: "make test"},
		Receipt{ToolName: "todo_write", Success: true},
		Receipt{ToolName: "todo_write", Success: false},
		Receipt{ToolName: "complete_step", Success: true, StepProof: true},
		Receipt{ToolName: "complete_step", Success: true},
	)
	got := l.ReceiptProgressSummary()
	if got.Writes != 2 || got.Commands != 1 || got.Todos != 1 || got.Signoffs != 1 {
		t.Fatalf("summary = %+v, want 2 writes, 1 command, 1 todo, 1 signoff", got)
	}
	var nilLedger *Ledger
	if nilLedger.ReceiptProgressSummary() != (ReceiptProgressSummary{}) {
		t.Fatal("a nil ledger has no progress")
	}
}

func TestPathsProvenInSessionNeedsEveryPathAndIgnoresFailedCalls(t *testing.T) {
	call := func(id, name, path string) provider.ToolCall {
		args, _ := json.Marshal(map[string]string{"path": path})
		return provider.ToolCall{ID: id, Name: name, Arguments: string(args)}
	}
	facts := func(name string) ToolFacts {
		return ToolFacts{ReadOnly: name == "read_file", WritesNamedPaths: name == "edit_file"}
	}
	msgs := []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{call("1", "edit_file", "a.go"), call("2", "edit_file", "b.go"), call("3", "read_file", "c.go")}},
		{Role: provider.RoleTool, ToolCallID: "2", Content: "error: permission denied"},
	}
	if !PathsProvenInSession(msgs, []string{"a.go"}, true, facts) {
		t.Fatal("a.go was written by a call that did not fail")
	}
	if PathsProvenInSession(msgs, []string{"a.go", "b.go"}, true, facts) {
		t.Fatal("b.go's write failed, so both paths are not proven")
	}
	if PathsProvenInSession(msgs, []string{"c.go"}, true, facts) {
		t.Fatal("a read does not prove a write")
	}
	if !PathsProvenInSession(msgs, []string{"c.go"}, false, facts) {
		t.Fatal("a read proves the path was looked at when writes are not required")
	}
	if PathsProvenInSession(msgs, nil, false, facts) {
		t.Fatal("no paths proves nothing")
	}
}

func TestHasSuccessfulBashMentioningPathsNeedsEveryPathInASuccessfulCommand(t *testing.T) {
	l := recorded(
		Receipt{ToolName: "bash", Success: true, Command: `seq 1 3 > Out/Data.txt`},
		Receipt{ToolName: "bash", Success: false, Command: `echo hi > failed.txt`},
		Receipt{ToolName: "edit_file", Success: true, Command: `notes.txt`},
		Receipt{ToolName: "bash", Success: true, Command: `copy x C:\work\win.txt`},
	)
	if !l.HasSuccessfulBashMentioningPaths([]string{"out/data.txt"}) {
		t.Fatal("the redirect target is named in a successful command, ignoring case")
	}
	if !l.HasSuccessfulBashMentioningPaths([]string{"out/data.txt", "c:/work/win.txt"}) {
		t.Fatal("backslashes in the command read as slashes")
	}
	if l.HasSuccessfulBashMentioningPaths([]string{"out/data.txt", "failed.txt"}) {
		t.Fatal("a failed command proves nothing about its path")
	}
	if l.HasSuccessfulBashMentioningPaths([]string{"notes.txt"}) {
		t.Fatal("only bash commands count")
	}
	var nilLedger *Ledger
	if nilLedger.HasSuccessfulBashMentioningPaths([]string{"a"}) || l.HasSuccessfulBashMentioningPaths(nil) {
		t.Fatal("a nil ledger and no paths prove nothing")
	}
}
