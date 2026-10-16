package control

import (
	"errors"
	"testing"

	"reasonix/internal/state/sessioninbox"
)

func pausedInboxWith(t *testing.T, submit string, extra map[string]string) (*Controller, string) {
	t.Helper()
	c, _, _ := newInboxDispatchController(t)
	if err := c.SetInboxPaused(true); err != nil {
		t.Fatal(err)
	}
	rec, err := c.EnqueueInbox(InboxRequest{Submit: submit, Extra: extra})
	if err != nil {
		t.Fatal(err)
	}
	return c, rec.ItemID
}

func TestAppendInboxItemMergesTextAndBindsTheMessageIDAsAnAlias(t *testing.T) {
	c, id := pausedInboxWith(t, "first line", nil)
	meta, err := c.AppendInboxItem(id, "  second line  ", "platform-msg-7", nil)
	if err != nil {
		t.Fatal(err)
	}
	if meta.ID != id {
		t.Fatalf("append returned item %q, want the same durable item %q", meta.ID, id)
	}
	_, env, err := c.ReadInboxItem(id)
	if err != nil {
		t.Fatal(err)
	}
	if env.SubmitText != "first line\nsecond line" || env.DisplayText != env.SubmitText || env.RawText != env.SubmitText {
		t.Fatalf("merged text = submit %q display %q raw %q", env.SubmitText, env.DisplayText, env.RawText)
	}
	again, err := c.EnqueueInbox(InboxRequest{Submit: "second line", Idempotency: "platform-msg-7"})
	if err != nil {
		t.Fatal(err)
	}
	if again.ItemID != id {
		t.Fatalf("the redelivered platform message created %q instead of resolving to %q", again.ItemID, id)
	}
}

func TestAppendInboxItemRefusesNothingToAddAndWhatIsNotThere(t *testing.T) {
	c, id := pausedInboxWith(t, "first line", nil)
	if _, err := c.AppendInboxItem(id, "   ", "k", nil); !errors.Is(err, sessioninbox.ErrEmpty) {
		t.Fatalf("blank append = %v, want ErrEmpty", err)
	}
	if _, err := c.AppendInboxItem("no-such-item", "text", "k", nil); !errors.Is(err, sessioninbox.ErrNotFound) {
		t.Fatalf("unknown id = %v, want ErrNotFound", err)
	}
	_, env, err := c.ReadInboxItem(id)
	if err != nil || env.SubmitText != "first line" {
		t.Fatalf("a refused append changed the item: %q (%v)", env.SubmitText, err)
	}
}

func TestUpdateInboxItemReplacesTheWordsAndFallsBackAcrossFields(t *testing.T) {
	c, id := pausedInboxWith(t, "original", nil)
	meta, err := c.UpdateInboxItem(id, "shown", "raw words", "  sent words  ")
	if err != nil {
		t.Fatal(err)
	}
	if meta.ID != id {
		t.Fatalf("update returned %q, want %q", meta.ID, id)
	}
	_, env, err := c.ReadInboxItem(id)
	if err != nil {
		t.Fatal(err)
	}
	if env.SubmitText != "sent words" || env.DisplayText != "shown" || env.RawText != "raw words" {
		t.Fatalf("after update: submit %q display %q raw %q", env.SubmitText, env.DisplayText, env.RawText)
	}
	if _, err := c.UpdateInboxItem(id, "", "", "only submit"); err != nil {
		t.Fatal(err)
	}
	_, env, _ = c.ReadInboxItem(id)
	if env.DisplayText != "only submit" || env.RawText != "only submit" {
		t.Fatalf("display and raw must follow submit when blank: %q / %q", env.DisplayText, env.RawText)
	}
	if _, err := c.UpdateInboxItem("no-such-item", "a", "a", "a"); !errors.Is(err, sessioninbox.ErrNotFound) {
		t.Fatalf("unknown id = %v, want ErrNotFound", err)
	}
}
