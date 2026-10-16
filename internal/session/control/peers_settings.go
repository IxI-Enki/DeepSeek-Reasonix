package control

import "reasonix/internal/contract/config"

// PeersSettings is whether this machine's sessions take part in messages
// between sessions, as the user file records it. It is the user's alone: a
// project file cannot set it, so there is no second effective value.
type PeersSettings struct {
	Enabled bool   `json:"enabled"`
	Path    string `json:"path"`
}

// PeersSettings reads [peers] enabled from the user file.
func (c *Controller) PeersSettings() PeersSettings {
	path := config.UserConfigPath()
	return PeersSettings{Enabled: config.LoadForEdit(path).PeersEnabled(), Path: path}
}

// SavePeersSettings persists the choice to the user file. A session decides at
// start whether it publishes itself and carries the peer tools, so the choice
// reaches the sessions opened after it, not the ones already running.
func (c *Controller) SavePeersSettings(enabled bool) error {
	unlock := config.LockUserConfigEdits()
	defer unlock()
	path := config.UserConfigPath()
	cfg := config.LoadForEdit(path)
	cfg.SetPeersEnabled(enabled)
	return cfg.SaveTo(path)
}
