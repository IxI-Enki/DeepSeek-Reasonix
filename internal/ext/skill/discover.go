package skill

import "reasonix/internal/contract/config"

func (s *Store) discover(scan func(discoveryRoot) []Skill) []Skill {
	if s == nil || s.disableDiscovery {
		return nil
	}
	var out []Skill
	disabled := s.disabledSet()
	for _, r := range s.roots() {
		if r.Status != StatusOK {
			continue
		}
		for _, sk := range scan(r) {
			if disabled[config.SkillNameKey(sk.Name)] {
				continue
			}
			if len(r.plugins) == 0 {
				out = append(out, sk)
				continue
			}
			for _, plugin := range r.plugins {
				owned := sk
				owned.Plugin = plugin
				if r.forceSubagent {
					owned.SlashPrefix = plugin + ":agent"
				}
				out = append(out, owned)
			}
		}
	}
	if !s.disableBuiltins {
		for _, sk := range builtinSkills() {
			if !disabled[config.SkillNameKey(sk.Name)] {
				out = append(out, sk)
			}
		}
	}
	return out
}
