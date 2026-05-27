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
When generating the step-by-step plan, you MUST structure every milestone/step/stage as an H3 level markdown header starting with one of the following prefixes:
- `### Etapa X: [Title]`
- `### Stage X: [Title]`
- `### Paso X: [Title]`
- `### Step X: [Title]`

(Where X is the stage number, starting at 1, e.g. 1, 2, 3, etc.)
Under each stage header, include the detailed checklist of actions to be executed.
Do NOT use plain bold text or bullet items for stage headers. Always use H3 level headers starting with `#` to ensure proper parsing.

