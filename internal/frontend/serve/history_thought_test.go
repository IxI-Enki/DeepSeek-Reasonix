package serve

import (
	"testing"

	"reasonix/internal/contract/provider"
)

// A reopened transcript has no live frame to time the thought from, so the
// host's measure has to ride the history the window rebuilds from.
func TestHistoryCarriesTheMeasuredThinkingTime(t *testing.T) {
	got := historyMessages([]provider.Message{
		{Role: provider.RoleUser, Content: "q"},
		{Role: provider.RoleAssistant, Content: "a", ReasoningContent: "r", ThoughtMs: 65800},
	})
	if got[1].ThoughtMs != 65800 || got[1].Reasoning != "r" {
		t.Fatalf("history row = %+v, want the reasoning and its 65800 ms", got[1])
	}
}

// How long a turn ran is the kernel's to report, so a reopened session shows
// it only on the answer that closed a turn, never on a step that called a tool.
func TestHistoryCarriesRunTimeOnlyOnTheClosingAnswer(t *testing.T) {
	got := historyMessages([]provider.Message{
		{Role: provider.RoleUser, Content: "q"},
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: "c", Name: "bash"}}, WorkDurationMs: 4000},
		{Role: provider.RoleTool, ToolCallID: "c", Content: "ok", WorkDurationMs: 4100},
		{Role: provider.RoleAssistant, Content: "a", WorkDurationMs: 9000},
	})
	want := []int64{0, 0, 0, 9000}
	for i, w := range want {
		if got[i].WorkDurationMs != w {
			t.Errorf("row %d WorkDurationMs = %d, want %d", i, got[i].WorkDurationMs, w)
		}
	}
}
