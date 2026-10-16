package control

import (
	"errors"
	"fmt"
	"strings"
)

// peerCommand serves /peer for the frontends that route raw input through
// Submit: list what is listening and what is held, approve, deny.
func (c *Controller) peerCommand(args string) {
	if !c.PeersEnabled() {
		c.notice("messages between sessions are not turned on (peers.enabled in your user config)")
		return
	}
	verb, rest, _ := strings.Cut(strings.TrimSpace(args), " ")
	rest = strings.TrimSpace(rest)
	switch strings.ToLower(verb) {
	case "", "list":
		c.notice(c.peerListText())
	case "approve", "deny":
		if rest == "" {
			c.notice("usage: /peer " + verb + " <message id>")
			return
		}
		if err := c.ResolvePeerMessage(rest, strings.EqualFold(verb, "approve")); err != nil {
			c.notice("peer " + verb + ": " + peerErrorText(err))
			return
		}
		c.notice("peer " + strings.ToLower(verb) + ": " + rest + " done")
	default:
		c.notice("usage: /peer [list | approve <id> | deny <id>]")
	}
}

func (c *Controller) peerListText() string {
	var b strings.Builder
	peers := c.Peers()
	if len(peers) == 0 {
		b.WriteString("no other session is listening on this machine")
	} else {
		b.WriteString("sessions listening on this machine:")
		for _, p := range peers {
			b.WriteString("\n  " + peerLabel(p) + "  (" + p.Key + ")")
		}
	}
	for _, h := range c.HeldPeerMessages() {
		fmt.Fprintf(&b, "\nwaiting for your decision  %s  from %s: %s", h.ID, peerLabel(PeerView{Title: h.FromTitle, Project: h.FromProject, Key: h.FromSession}), h.Body)
	}
	return b.String()
}

func peerLabel(p PeerView) string {
	switch {
	case p.Project != "" && p.Title != "":
		return p.Project + "/" + p.Title
	case p.Title != "":
		return p.Title
	}
	return p.Key
}

func peerErrorText(err error) string {
	for _, known := range []error{ErrPeersDisabled, ErrPeerNotFound, ErrPeerAmbiguous, ErrPeerSelf, ErrPeerRefused, ErrPeerRateLimited, ErrPeerEmpty, ErrPeerTooLarge, ErrPeerNotHeld} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	return err.Error()
}

func (c *Controller) argumentCommand(verb, args string) {
	if verb == "/feedback" {
		c.feedbackCommand(args)
		return
	}
	c.peerCommand(args)
}
