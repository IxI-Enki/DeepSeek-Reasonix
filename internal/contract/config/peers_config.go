package config

// PeersConfig governs messages between sessions of one user on one machine.
type PeersConfig struct {
	// Enabled publishes this session to its peers and reads its own spool. Off
	// by default; the user file only, so a cloned repo cannot open the door.
	Enabled bool `toml:"enabled"`
}

// PeersEnabled reports whether this session takes part in messages between
// sessions.
func (c *Config) PeersEnabled() bool { return c != nil && c.Peers.Enabled }

// SetPeersEnabled records the user's choice in the user file.
func (c *Config) SetPeersEnabled(on bool) { c.Peers.Enabled = on }
