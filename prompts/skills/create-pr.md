---
name: create-pr
description: Open a GitHub pull request for the current branch's commits using the GitHub MCP
---

# Skill: Create a GitHub Pull Request

Use when asked to open/create a PR. Requires the GitHub MCP server connected (tools appear as
`mcp:github/...`). Do NOT claim a PR was created unless a tool call actually returned a URL.

Steps:

1. **Confirm what will go in the PR.** `run_command`:
   - `git branch --show-current` (the head branch)
   - `git log --oneline origin/main..HEAD` (commits ahead of base)
   - `git diff origin/main..HEAD --stat` (files changed)
   If there are no commits ahead of base, STOP and tell the user there's nothing to PR.
2. **Push the branch** if needed: `run_command` `git push -u origin <branch>`.
3. **Search for the PR tool** if it's not already visible: `search_tools` with `"github create pull request"`,
   then call the GitHub MCP tool (e.g. `mcp:github/create_pull_request`) with: base (`main`), head
   (current branch), a concise title, and a body summarizing the commits/changes.
4. **Report the real URL** returned by the tool. If the tool call failed or returned no URL, say so
   plainly — never fabricate a PR or a URL.
