/**
 * Detects when the model TRIED to call a tool but emitted it as text/XML instead of using the
 * native function-calling interface (e.g. `<read_files>`, `<edit_file>`, or the legacy XML action
 * tags). Without this, such a turn is silently treated as a plain-text final answer and nothing
 * happens. Extracted from generator-tools (Phase 2) so it can be shared without an import cycle.
 *
 * PRECISION matters: a model ANALYSING REI's own tool code writes prose that *mentions* `<edit>`,
 * `read_files`, `<parameter=`, etc. That is a real answer, not a faked call — flagging it discards
 * the answer and derails the model. So we only treat content as an attempted call when the tag
 * actually LEADS the message (the whole message is the call) or the message is short and
 * tag-dominated, and we ignore any tag that appears inside Markdown code (fences or `inline`),
 * which is the model quoting/discussing syntax.
 */
const TOOL_TAG =
  "read_files|edit_file|create_file|run_command|edit|create|wholefile|request_files|execute_command|call_tool";
const LEADING_TAG = new RegExp(
  `^[\\s>*_-]*<\\s*(?:${TOOL_TAG}|parameter)\\b|^[\\s>*_-]*<parameter\\s*=`,
  "i",
);
const ANY_TAG = new RegExp(`<\\s*(?:${TOOL_TAG})\\b|<parameter\\s*=`, "i");

/** Max length for a "short, tag-dominated" message that's a faked call rather than a real answer. */
const TAG_DOMINATED_MAX = 160;

export function looksLikeAttemptedToolCall(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();

  // A genuine faked call leads with the tag — the whole message IS the call.
  if (LEADING_TAG.test(trimmed)) return true;

  // Otherwise, ignore tags that only appear inside Markdown code (fenced ``` blocks or `inline`
  // spans) — there the model is quoting/discussing syntax, not calling a tool.
  const outsideCode = trimmed
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");
  if (!ANY_TAG.test(outsideCode)) return false;

  // A bare tag survives outside code but isn't leading: only a faked call if the message is short
  // and tag-dominated (not a real prose answer that happens to name a tag).
  return trimmed.length <= TAG_DOMINATED_MAX;
}

// ── Narrate-don't-act detection ───────────────────────────────────────────────
// A weak local model often ANNOUNCES an investigation in natural language ("leamos los archivos",
// "voy a leer", "let me read the files") and then STOPS without emitting the tool call — leaving a
// short, useless "I'll do X" message. This is NOT a faked tool call (no tag), so looksLikeAttempted
// misses it. Detect it conservatively: a SHORT response that voices imminent investigation intent
// and references reading/files/code, and is NOT already a real plan (no `## Stage`).
const ANNOUNCE_VERB =
  /\b(voy a|vamos a|primero (?:voy|le|revis|analic|busc)|d[ée]jame (?:leer|revisar|ver|mirar)|leamos|revisemos|analicemos|miremos|let me (?:read|check|look|inspect|start|examine|explore)|let'?s (?:read|start|check|look|examine|explore)|i'?ll (?:read|check|look|inspect|start|examine|explore)|i will (?:read|check|look|inspect|start|examine|explore))\b/i;
const INVESTIGATE_NOUN =
  /\b(archivos?|leer|read|files?|c[óo]digo|code|revisar|inspect|examin|analiz|analyz|buscar|search|grep|ver)\b/i;
const ANNOUNCEMENT_MAX = 400;

export function looksLikeUnfulfilledAnnouncement(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length > ANNOUNCEMENT_MAX) return false; // a real plan/answer is longer
  if (/##\s*stage/i.test(trimmed)) return false; // already a structured plan → not an empty promise
  return ANNOUNCE_VERB.test(trimmed) && INVESTIGATE_NOUN.test(trimmed);
}
