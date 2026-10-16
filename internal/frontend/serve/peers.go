package serve

import (
	"encoding/json"
	"errors"
	"net/http"

	"reasonix/internal/session/control"
)

const (
	codePeersDisabled = "peer.disabled"
	codePeerNotHeld   = "peer.not_held"
	codePeerFailed    = "peer.failed"
)

func (s *Server) registerPeerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /peers", s.peers)
	mux.HandleFunc("GET /peers/settings", s.peersSettings)
	mux.HandleFunc("POST /peers/settings", s.savePeersSettings)
	mux.HandleFunc("POST /peers/held/{id}", s.resolvePeerMessage)
}

func (s *Server) peers(w http.ResponseWriter, _ *http.Request) {
	ctl := s.ctl()
	peers, held := ctl.Peers(), ctl.HeldPeerMessages()
	if peers == nil {
		peers = []control.PeerView{}
	}
	if held == nil {
		held = []control.PeerHeld{}
	}
	writeJSON(w, map[string]any{"enabled": ctl.PeersEnabled(), "peers": peers, "held": held})
}

func (s *Server) peersSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, s.ctl().PeersSettings())
}

// savePeersSettings and resolvePeerMessage ride the provider-edit grant: the
// first opens a door between sessions and a held message becomes input to a
// model, so a networked client must not decide either for the machine's owner.
// Saving rebuilds nothing: a session decides at start, so the choice is for the
// sessions opened afterwards.
func (s *Server) savePeersSettings(w http.ResponseWriter, r *http.Request) {
	if !s.grants.at(r).providerEdit {
		refuse(w, http.StatusForbidden, "peer.editing_disabled", "messages between sessions are not enabled for this client", nil)
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Enabled == nil {
		badBody(w)
		return
	}
	if err := s.ctl().SavePeersSettings(*body.Enabled); err != nil {
		saveFailed(w, http.StatusInternalServerError, "peer.save_failed", err)
		return
	}
	writeJSON(w, s.ctl().PeersSettings())
}

func (s *Server) resolvePeerMessage(w http.ResponseWriter, r *http.Request) {
	if !s.grants.at(r).providerEdit {
		refuse(w, http.StatusForbidden, "peer.editing_disabled", "messages between sessions are not enabled for this client", nil)
		return
	}
	var body struct {
		Approve *bool `json:"approve"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Approve == nil {
		badBody(w)
		return
	}
	if err := s.ctl().ResolvePeerMessage(r.PathValue("id"), *body.Approve); err != nil {
		refusePeer(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func refusePeer(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, control.ErrPeersDisabled):
		refuse(w, http.StatusConflict, codePeersDisabled, "messages between sessions are not enabled", nil)
	case errors.Is(err, control.ErrPeerNotHeld):
		refuse(w, http.StatusNotFound, codePeerNotHeld, "that message is no longer waiting", nil)
	default:
		saveFailed(w, http.StatusInternalServerError, codePeerFailed, err)
	}
}
