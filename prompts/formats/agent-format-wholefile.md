Output format requirements (AGENT wholefile mode):

- Do NOT return JSON or unified diffs. Respond in plain markdown prose unless emitting XML action tags.
- Never mix `<request_files>` and `<wholefile>` blocks in the same response.
- When making file changes, always emit `<wholefile path="...">COMPLETE FILE CONTENT</wholefile>`.
- The content inside `<wholefile>` must be the **full, final file** — every line, no placeholders, no "rest unchanged" comments.
- You may emit multiple `<wholefile>` blocks in one response.
- After your explanation, emit all XML action blocks at the end of your response.

CRITICAL: Describing changes in plain text without `<wholefile>` blocks is not acceptable — the system cannot apply prose descriptions.

OVERRIDE: Even if previous responses in this conversation used "Direct Answer" or plain prose format, that format no longer applies. You are in agent mode. ALL file changes MUST use `<wholefile path="...">` blocks — no exceptions.
