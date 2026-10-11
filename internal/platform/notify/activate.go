package notify

import "sync/atomic"

var onActivate atomic.Pointer[func()]

// OnActivate runs fn when the user clicks a notification this process sent.
// Only platforms whose notifications call back into the sender ever fire it.
func OnActivate(fn func()) { onActivate.Store(&fn) }

// activated is the platform sender's way of reporting a click.
func activated() {
	if fn := onActivate.Load(); fn != nil {
		(*fn)()
	}
}
