package notify

import "testing"

func TestAClickReachesTheHandlerTheHostBound(t *testing.T) {
	var clicks int
	OnActivate(func() { clicks++ })
	activated()
	activated()
	if clicks != 2 {
		t.Fatalf("handler ran %d times for two clicks", clicks)
	}
	OnActivate(func() {})
	t.Cleanup(func() { OnActivate(func() {}) })
}

func TestAClickWithNoHandlerIsHarmless(t *testing.T) {
	onActivate.Store(nil)
	activated()
}
