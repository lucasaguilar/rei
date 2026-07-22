import type { CommandHandler, CommandResult } from "./command-handler.js";
import type { ChatMessage, SessionMode } from "../types.js";
import { saveSession } from "../session-store.js";

/**
 * Read-only navigation + detour-pruning of the session, viewed as a list of turns. Each turn = a
 * user prompt plus the assistant/tool messages it produced (grouped by the `turnId` stamped in
 * agent.ts; robust even for older sessions whose messages predate turnId). `/tree prune <n>` marks a
 * turn as an off-topic detour so it's excluded from the model context (kept on disk, restored with
 * `/tree keep <n>`) — whole turns are pruned together so message pairing stays intact.
 * See docs/context-drift-spec.md.
 */

export interface TurnSummary {
  /** 1-based display index (what the user references in prune/keep). */
  index: number;
  /** The stamped turn id, when present (correlates with agent-flow.jsonl). */
  turnId?: string;
  /** Session mode that produced the turn, when known (from a message's sourceMode). */
  mode?: SessionMode;
  /** The user prompt, single-lined and truncated — the turn's title. */
  title: string;
  /** How many messages the turn holds (prompt + responses). */
  messageCount: number;
  /** True when the whole turn is pruned (excluded from model context). */
  pruned: boolean;
}

interface TurnGroup {
  summary: TurnSummary;
  /** Indices into the original messages array that belong to this turn. */
  indices: number[];
}

const TITLE_MAX = 64;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/** Groups the message list into per-turn groups (pure). System messages are skipped; a `user`
 *  message opens a new turn; following messages attach to the open turn. A turn is `pruned` only
 *  when ALL its messages are pruned (whole-turn semantics). */
function groupTurns(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | undefined;

  messages.forEach((m, i) => {
    if (m.role === "system") return;

    if (m.role === "user" || !current) {
      current = {
        summary: {
          index: groups.length + 1,
          turnId: m.turnId,
          mode: m.sourceMode,
          title: m.role === "user" ? oneLine(m.content) : "(no prompt)",
          messageCount: 1,
          pruned: m.pruned === true,
        },
        indices: [i],
      };
      groups.push(current);
      return;
    }

    current.summary.messageCount += 1;
    current.indices.push(i);
    if (!current.summary.turnId && m.turnId) current.summary.turnId = m.turnId;
    if (!current.summary.mode && m.sourceMode) current.summary.mode = m.sourceMode;
    if (m.pruned !== true) current.summary.pruned = false;
  });

  return groups;
}

/** Per-turn summaries (pure — unit-tested). */
export function summarizeTurns(messages: ChatMessage[]): TurnSummary[] {
  return groupTurns(messages).map((g) => g.summary);
}

const MODE_GLYPH: Record<SessionMode, string> = {
  ask: "🚀",
  planning: "🎯",
  agent: "🧠",
};

const HINT =
  "Prune a detour: /tree prune <n>  (range: 26-28) · restore: /tree keep <n>";

/** Renders the turn summaries as a compact, terminal-only tree. */
export function renderSessionTree(turns: TurnSummary[]): string {
  if (turns.length === 0) return "[REI] Session tree is empty — no turns yet.";

  const width = String(turns.length).length;
  const lines = turns.map((t) => {
    const idx = String(t.index).padStart(width);
    const glyph = t.mode ? MODE_GLYPH[t.mode] : "  ";
    const count = `(${t.messageCount} msg${t.messageCount === 1 ? "" : "s"})`;
    const mark = t.pruned ? "  ✂️ pruned" : "";
    return `  ${idx}  ${glyph}  ${t.title.padEnd(TITLE_MAX)}  ${count}${mark}`;
  });
  const prunedCount = turns.filter((t) => t.pruned).length;
  const header =
    `### SESSION TREE (${turns.length} turns` +
    (prunedCount > 0 ? `, ${prunedCount} pruned` : "") +
    `)`;
  return `${header}\n\n${lines.join("\n")}\n\n${HINT}`;
}

/** Parses a prune/keep target spec ("28", "26-28", "26-28 31") into a sorted list of valid,
 *  in-range 1-based turn indices. */
export function parseIndexSpec(spec: string, max: number): number[] {
  const out = new Set<number>();
  for (const tok of spec.split(/[\s,]+/).filter(Boolean)) {
    const range = tok.match(/^(\d+)-(\d+)$/);
    const single = tok.match(/^(\d+)$/);
    if (range) {
      const lo = Math.min(+range[1], +range[2]);
      const hi = Math.max(+range[1], +range[2]);
      for (let n = lo; n <= hi; n += 1) if (n >= 1 && n <= max) out.add(n);
    } else if (single) {
      const n = +single[1];
      if (n >= 1 && n <= max) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export const treeCommands: CommandHandler = {
  match: (c) => c === "/tree" || /^\/tree\s+(prune|keep)\s+.+$/.test(c),

  run: ({ command, session, workspacePath }): CommandResult => {
    const groups = groupTurns(session.messages);
    const action = command.match(/^\/tree\s+(prune|keep)\s+(.+)$/);

    if (action) {
      const prune = action[1] === "prune";
      const targets = parseIndexSpec(action[2], groups.length);
      if (targets.length === 0) {
        return {
          success: true,
          recordInSession: false,
          response: `[REI] No valid turn numbers in "${action[2].trim()}". Try /tree prune 28 or /tree prune 26-28.`,
        };
      }
      for (const n of targets) {
        for (const i of groups[n - 1].indices) session.messages[i].pruned = prune;
      }
      saveSession(
        workspacePath,
        session.messages,
        session.mode,
        session.summary,
        session.createdAt,
      );
      const verb = prune ? "Pruned" : "Restored";
      const effect = prune
        ? "excluded from the working context"
        : "back in the working context";
      const header = `[REI] ${verb} turn${targets.length === 1 ? "" : "s"} ${targets.join(", ")} — ${effect} (still on disk).`;
      return {
        success: true,
        recordInSession: false,
        response: `${header}\n\n${renderSessionTree(summarizeTurns(session.messages))}`,
      };
    }

    return {
      success: true,
      recordInSession: false,
      response: renderSessionTree(groups.map((g) => g.summary)),
    };
  },
};
