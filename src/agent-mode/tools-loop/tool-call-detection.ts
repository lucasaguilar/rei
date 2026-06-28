/**
 * Detects when the model TRIED to call a tool but emitted it as text/XML instead of using the
 * native function-calling interface (e.g. `<read_files>`, `<edit_file>`, or the legacy XML action
 * tags). Without this, such a turn is silently treated as a plain-text final answer and nothing
 * happens. Extracted from generator-tools (Phase 2) so it can be shared without an import cycle.
 */
export function looksLikeAttemptedToolCall(content: string): boolean {
  if (!content) return false;
  // Native tool names emitted as XML-ish tags, the legacy XML action tags, or the tell-tale
  // `<parameter=` shape models use when faking function calls as text.
  return (
    /<\s*(read_files|edit_file|create_file|run_command|edit|create|wholefile|request_files|execute_command|call_tool)\b/i.test(
      content,
    ) || /<parameter\s*=/i.test(content)
  );
}
