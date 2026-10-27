# Skills

Optional task recipes for coding agents, in the `<name>/SKILL.md` format that REI and Claude Code
both read. Nothing here is loaded by default: pick the ones you want and copy their folder into

- `~/.config/rei/skills/` (REI, every project) or `.rei/skills/` (one project)
- `~/.claude/skills/` (Claude Code) or `.claude/skills/` (one project)

Each skill's `description` says when to use it. Only that line rides in the agent's prompt on every
turn; the body is read when the skill is used. The `modes:` field is REI-specific: it picks which
modes offer the skill.

| Skill | What it does |
| --- | --- |
| [change-walkthrough](change-walkthrough/SKILL.md) | Explains a diff, commit or branch so you can own it: what changed and why, reading order, a small Mermaid flow, what to look at carefully. Read-only. |
