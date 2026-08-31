import type { CommandHandler, CommandResult } from "./command-handler.js";
import {
  getThinkingOverride,
  reasoningEffortValues,
  resolveReasoningEffort,
  setThinkingOverride,
} from "../../config/model-runtime.js";

/**
 * `/think <level>` overrides the reasoning budget for the running session; `/think off` clears it;
 * `/think` alone reports the active level AND where it comes from.
 *
 * Without this, changing the level meant editing `.env` and restarting — expensive mid-session with
 * a loaded context. The override lives in memory only (see setThinkingOverride), so a restart
 * returns to the `.env`.
 *
 * Reporting the SOURCE is half the point: with an env default, a per-model `thinking` intent and now
 * a live override all feeding the same field, there was no way to tell which one was in effect.
 *
 * Whether the backend honors the value is its business — it may cap it, map it, or ignore it. What
 * REI guarantees is that a valid value is SENT. Invalid ones are rejected here because the field is
 * validated server-side too (LM Studio 400s on anything outside the set), which would fail the turn.
 */
const THINK_RE = /^\/think(?:\s+(\S+))?$/i;
const CLEARERS = new Set(["off", "clear", "default", "reset", "none-override"]);

function statusLine(): string {
  const override = getThinkingOverride();
  if (override) return `[REI] Thinking: ${override}  (session override)`;
  const perMode = (["ask", "planning", "agent"] as const)
    .map((m) => `${m}=${resolveReasoningEffort(m) ?? "(model default)"}`)
    .join("  ·  ");
  return `[REI] Thinking: no override — per mode: ${perMode}`;
}

export const thinkCommands: CommandHandler = {
  match: (c) => THINK_RE.test(c.trim()),

  run: ({ command }): CommandResult => {
    const arg = command.trim().match(THINK_RE)?.[1]?.toLowerCase();
    const levels = reasoningEffortValues();

    if (!arg) {
      return {
        success: true,
        recordInSession: false,
        response:
          `${statusLine()}\n` +
          `Levels: ${levels.join(" · ")}\n` +
          `  /think <level>   override the level for this session\n` +
          `  /think off       fall back to the .env`,
      };
    }

    if (CLEARERS.has(arg)) {
      setThinkingOverride(undefined);
      return { success: true, recordInSession: false, response: `${statusLine()}` };
    }

    if (!levels.includes(arg)) {
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] '${arg}' is not a valid level.\n` +
          `Levels: ${levels.join(" · ")}  ·  /think off clears the override`,
      };
    }

    setThinkingOverride(arg);
    return {
      success: true,
      recordInSession: false,
      // "sent", not "applied": the backend decides whether to honor it.
      response: `[REI] Thinking: ${arg} — sent from the next turn on (the backend decides whether to honor it).`,
    };
  },
};
