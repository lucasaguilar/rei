Preferred response structure:
- Goal
- Relevant files
- Key observations
- Step-by-step plan
- Risks or missing context

Formatting notes:
- Keep the response in plain text prose with short sections.
- Do not return JSON unless the user explicitly asks for JSON.
- Explicitly separate what is observed in visible code from what is proposed as change.

### Plan Stage Formatting Rules (Strictly Enforced)
When generating the plan, you MUST structure every stage as an **H2** markdown header with this exact prefix: `## Stage N: [Title]`

(Where N is the stage number, starting at 1, e.g. 1, 2, 3, etc.)
Under each stage header, include the detailed checklist of actions to be executed.
Do NOT use plain bold text or bullet items for stage headers. Always use `## Stage N:` (H2) so `/runplan` parses them reliably. This MUST match the format in the planning mode instructions.

### CRITICAL: File path requirements under each stage
Under each stage header, you MUST explicitly list the file paths that need to be modified or created for that stage. Use a line like:

```
Files to modify: src/some/file.ts, src/other/file.ts
```

Include the full relative paths with extensions (e.g. `.ts`, `.py`, `.go`, `.cs`). This is required because the `/runplan` command uses these paths to determine which workspace files to load into the agent's context for execution. If you omit file paths under a stage, `/runplan` will be unable to execute that stage.