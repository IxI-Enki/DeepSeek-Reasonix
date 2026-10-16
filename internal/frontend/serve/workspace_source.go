package serve

import (
	"net/http"

	"reasonix/internal/contract/config"
	"reasonix/internal/contract/provider"
	"reasonix/internal/platform/worktree"
	"reasonix/internal/session/control"
)

type worktreeSelection struct {
	Ref         string   `json:"ref"`
	SourceRoot  string   `json:"sourceRoot"`
	Attachments []string `json:"attachments,omitempty"`
}

type worktreeSourcesView struct {
	Available  bool              `json:"available"`
	SourceRoot string            `json:"sourceRoot"`
	Sources    []worktree.Source `json:"sources"`
}

func (s *Server) workspaceSources(w http.ResponseWriter, r *http.Request) {
	ctrl := s.ctl()
	root := ctrl.WorkspaceRoot()
	view := worktreeSourcesView{SourceRoot: root, Sources: []worktree.Source{}}
	if s.grants.at(r).workspaceSwitch && emptyConversation(ctrl) && !controllerHasActiveRuntimeWork(ctrl) && !worktree.IsManagedPath(root, config.DeliveryWorktreeDir()) {
		repo := workspaceRepo(ctrl)
		view.Available = worktree.Inspect(r.Context(), repo).Available
		if view.Available {
			list, err := worktree.Sources(r.Context(), repo)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, err)
				return
			}
			view.Sources = list
		}
	}
	writeJSON(w, view)
}

func emptyConversation(ctrl control.SessionAPI) bool {
	for _, message := range ctrl.History() {
		if message.Role != provider.RoleSystem {
			return false
		}
	}
	return true
}
