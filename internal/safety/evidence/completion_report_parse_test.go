package evidence

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseCompletionReportNormalisesAValidReport(t *testing.T) {
	raw := json.RawMessage(`{"status":"  Complete ","summary":"  fixed the loop  ","acceptance_criteria":[
		{"id":" c1 ","status":"SATISFIED","evidence":[
			{"kind":" Verification ","summary":"ran","command":"go test ./..."},
			{"kind":"diff","summary":"d","paths":["a.go"]},
			{"kind":"files","summary":"f","paths":["b.go"]},
			{"kind":"review","summary":"r"},
			{"kind":"manual","summary":"m"}]}],
		"unresolved":["integration run"]}`)
	got, err := ParseCompletionReport(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != CompletionComplete || got.Summary != "fixed the loop" {
		t.Fatalf("status/summary = %q / %q", got.Status, got.Summary)
	}
	c := got.Criteria[0]
	if c.ID != "c1" || c.Status != CriterionSatisfied || c.Evidence[0].Kind != CompletionEvidenceVerification {
		t.Fatalf("criterion = %+v", c)
	}
	if len(got.Unresolved) != 1 {
		t.Fatalf("unresolved = %v", got.Unresolved)
	}
}

func TestParseCompletionReportRefusesWhatIsMalformedAndSaysWhere(t *testing.T) {
	for name, tc := range map[string]struct{ raw, want string }{
		"not json":                   {`{`, "invalid complete_subtask JSON"},
		"unknown status":             {`{"status":"done","summary":"x"}`, "status must be"},
		"missing status":             {`{"summary":"x"}`, "status must be"},
		"blank summary":              {`{"status":"complete","summary":"  "}`, "summary is required"},
		"criterion without id":       {`{"status":"partial","summary":"x","acceptance_criteria":[{"id":" ","status":"satisfied"}]}`, "acceptance_criteria[0].id"},
		"criterion with odd status":  {`{"status":"partial","summary":"x","acceptance_criteria":[{"id":"a","status":"maybe"}]}`, "acceptance_criteria[0].status"},
		"verification with no cmd":   {`{"status":"partial","summary":"x","acceptance_criteria":[{"id":"a","status":"satisfied","evidence":[{"kind":"verification","summary":"s"}]}]}`, "verification requires command"},
		"diff with no paths":         {`{"status":"partial","summary":"x","acceptance_criteria":[{"id":"a","status":"satisfied","evidence":[{"kind":"diff","summary":"s"}]}]}`, "diff requires paths"},
		"files with no paths":        {`{"status":"partial","summary":"x","acceptance_criteria":[{"id":"a","status":"satisfied","evidence":[{"kind":"files","summary":"s"}]}]}`, "files requires paths"},
		"unknown evidence kind":      {`{"status":"partial","summary":"x","acceptance_criteria":[{"id":"a","status":"satisfied","evidence":[{"kind":"vibes","summary":"s"}]}]}`, "not a known evidence kind"},
		"second criterion is broken": {`{"status":"partial","summary":"x","acceptance_criteria":[{"id":"a","status":"satisfied"},{"id":"","status":"satisfied"}]}`, "acceptance_criteria[1].id"},
	} {
		_, err := ParseCompletionReport(json.RawMessage(tc.raw))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want it to mention %q", name, err, tc.want)
		}
	}
}
