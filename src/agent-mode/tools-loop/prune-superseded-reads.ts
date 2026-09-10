import type { ChatMessage } from "../../chat/types.js";

/**
 * Drops file contents the model has already been shown again, later in the same turn.
 *
 * Tool results stay in the turn's message list and are re-sent on EVERY remaining model call, so
 * their cost is not their size — it is their size times the steps that follow. Reading a file,
 * editing it, and reading it back is the ordinary shape of an agent turn, and it puts the same
 * file in the window two or three times.
 *
 * The rule here is deliberately the narrow one: a section is dropped only when an IDENTICAL header
 * appears in a later read — same file, same line range, or both unpaged. That makes the dropped
 * bytes provably redundant rather than merely old. Pruning by age was the obvious alternative and
 * is not safe: a result from four calls ago may be exactly what the model is reasoning about, while
 * one from the last call may already be superseded.
 *
 * Paged reads are why the range is part of the identity. `lines 1-400` and `lines 401-800` of the
 * same file are different content, and treating the second as replacing the first would delete a
 * half of the file the model still needs.
 *
 * @module rei/agent-mode/tools-loop/prune-superseded-reads
 */

/** Only read_files output carries these; it is the tool whose results are big AND repeated. */
const FILE_HEADER = /^--- File: .+ ---$/gm;

const stub = (header: string): string =>
  `${header}\n(contents omitted — this exact file range is shown again in a later read below.)`;

/** Splits a read_files result into `[header, body]` sections, keeping any preamble as a lead. */
function sections(content: string): { lead: string; parts: Array<{ header: string; body: string }> } {
  const headers = [...content.matchAll(FILE_HEADER)];
  if (headers.length === 0) return { lead: content, parts: [] };
  const lead = content.slice(0, headers[0].index);
  const parts = headers.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < headers.length ? headers[i + 1].index! : content.length;
    return { header: m[0], body: content.slice(start + m[0].length, end) };
  });
  return { lead, parts };
}

/**
 * Returns a new message list with superseded file sections replaced by a one-line stub.
 *
 * Messages are never removed and `tool_call_id`s are untouched: a tool result must stay paired with
 * the call that produced it, or the next request is malformed.
 */
export function pruneSupersededReads(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const out = [...messages];

  // Newest first: the LAST occurrence of a header is the one that survives.
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (msg.role !== "tool" || msg.name !== "read_files" || typeof msg.content !== "string") {
      continue;
    }
    const { lead, parts } = sections(msg.content);
    if (parts.length === 0) continue;

    let changed = false;
    const rebuilt = parts.map(({ header, body }) => {
      if (seen.has(header)) {
        const replacement = stub(header);
        // Never grow the context in the name of shrinking it — a tiny section's stub can be
        // longer than the section itself.
        if (replacement.length < header.length + body.length) {
          changed = true;
          return replacement;
        }
        return header + body;
      }
      seen.add(header);
      return header + body;
    });

    if (changed) out[i] = { ...msg, content: lead + rebuilt.join("") };
  }
  return out;
}
