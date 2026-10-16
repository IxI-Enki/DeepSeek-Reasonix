package config

import "strings"

func renderAgentLimits(b *strings.Builder, c, defaults *Config) {
	agentSetting(b, "max_subagent_depth", c.Agent.MaxSubagentDepth, defaults.Agent.MaxSubagentDepth, "nested subagent delegation depth; 1 restores the old single-layer boundary")
	agentSetting(b, "max_subagent_concurrency", c.Agent.MaxSubagentConcurrency, defaults.Agent.MaxSubagentConcurrency, "session-wide sub-agent concurrency (task/fleet/skills)")
	agentSetting(b, "max_parallel_writers", c.Agent.MaxParallelWriters, defaults.Agent.MaxParallelWriters, "concurrent writers with non-overlapping write_paths")
	agentSetting(b, "subagent_claims", c.Agent.SubagentClaims, defaults.Agent.SubagentClaims, "optimistic: a sub-agent that declared no write_paths holds only the path it is writing, not the whole workspace; user file only")
	agentSetting(b, "write_lease", c.Agent.WriteLease, defaults.Agent.WriteLease, "optimistic: a writer that declared no path does not hold the whole workspace against other sessions; user file only")
	agentSetting(b, "host_verification", c.Agent.HostVerification, defaults.Agent.HostVerification, "off: the host does not hold a turn open to ask for a check, a review or a sign-off on files it changed; the receipt still says what was and was not checked; user file only")
}

func renderPeers(b *strings.Builder, c *Config, scope RenderScope) {
	if scope == RenderScopeProject {
		return
	}
	b.WriteString("[peers]\nenabled = ")
	if c.Peers.Enabled {
		b.WriteString("true")
	} else {
		b.WriteString("false")
	}
	b.WriteString("   # messages between sessions on this machine; off by default; user file only\n\n")
}
