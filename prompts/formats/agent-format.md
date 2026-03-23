Output format requirements (AGENT mode):
- Return exactly one JSON object that conforms to the injected AgentResponse contract.
- Return JSON only (no markdown fences, no prose before/after, no bullet lists).
- Use valid JSON syntax with double-quoted keys/strings.
- Include all fields from the contract; for array fields that do not apply, return an empty array.
- Keep paths workspace-relative in all file/target fields.
