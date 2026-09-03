import type { CommandHandler, CommandResult } from "./command-handler.js";
import {
  getThinkingOverride,
  mapThinkingLevel,
  reasoningEffortValues,
  resolveReasoningEffort,
  setThinkingOverride,
} from "../../config/model-runtime.js";
import { resolveModelTuning } from "../../config/model-tuning.js";
import { resolveModelForMode } from "../../providers/provider-factory.js";
import type { SessionMode } from "../types.js";

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

/**
 * The level map of the model this mode would use.
 *
 * Resolved here rather than via getActiveModelTuning(): that is set once per TURN, and a command is
 * not a turn — it would read whatever the last turn left behind, or nothing at all on a fresh
 * session.
 */
function levelMapForMode(
  workspacePath: string,
  mode: SessionMode,
): { model?: string; map?: Record<string, string | null> } {
  const model = resolveModelForMode(mode);
  const tuning = model ? resolveModelTuning(model, workspacePath) : undefined;
  return { model, map: tuning?.thinkingLevelMap };
}

/** Levels this model actually accepts, or null when it declares no map. */
function supportedLevels(map?: Record<string, string | null>): string[] | null {
  if (!map) return null;
  return reasoningEffortValues().filter((l) => mapThinkingLevel(l, map) !== undefined);
}

/**
 * What is in effect RIGHT NOW, leading with the active mode.
 *
 * Listing all three modes made the reader hunt for their own — the question `/think` answers is
 * "what level am I on?", so that goes first, with the others as context. Naming the SOURCE matters
 * just as much: an override, a per-model default, a per-mode env value and a binary intent all feed
 * one field, and nothing used to say which one won.
 */
function statusLine(workspacePath: string, mode: SessionMode): string {
  const level = resolveReasoningEffort(mode) ?? "(model default — the field is not sent)";
  const override = getThinkingOverride();

  const model = resolveModelForMode(mode);
  const tuned = model ? resolveModelTuning(model, workspacePath)?.reasoningEffort : undefined;
  const source = override
    ? "/think override, this session"
    : tuned
      ? `reasoningEffort for ${model} in rei.config.json`
      : `REI_REASONING_EFFORT_${mode.toUpperCase()} in .env`;

  const others = (["ask", "planning", "agent"] as const)
    .filter((m) => m !== mode)
    .map((m) => `${m}=${resolveReasoningEffort(m) ?? "(model default)"}`)
    .join("  ·  ");

  return (
    `[REI] Thinking: ${level}   ← ${mode} mode\n` +
    `  from: ${source}\n` +
    `  other modes: ${others}`
  );
}

export const thinkCommands: CommandHandler = {
  match: (c) => THINK_RE.test(c.trim()),

  run: (ctx): CommandResult => {
    const { command } = ctx;
    const arg = command.trim().match(THINK_RE)?.[1]?.toLowerCase();
    // Defensive: a command context without a session is not the norm, but /think must degrade to the
    // global level list rather than fail.
    const { model, map } = levelMapForMode(
      ctx.workspacePath ?? process.cwd(),
      ctx.session?.mode ?? ("agent" as SessionMode),
    );
    const modelLevels = supportedLevels(map);
    const levels = reasoningEffortValues();

    if (!arg) {
      return {
        success: true,
        recordInSession: false,
        response:
          `${statusLine(ctx.workspacePath, ctx.session?.mode ?? ("agent" as SessionMode))}\n` +
          (modelLevels
            ? `Levels for ${model}: ${modelLevels.join(" · ")}\n`
            : `Levels: ${levels.join(" · ")}\n`) +
          `  /think <level>   override the level for this session\n` +
          `  /think off       fall back to the .env`,
      };
    }

    // `/think [level]` — the help entry's placeholder, pasted verbatim. Treat it as "show me the
    // options" rather than an error: the user is clearly asking what to type.
    if (/^[[<(].*[\]>)]$/.test(arg) || arg === "level" || arg === "nivel") {
      return {
        success: true,
        recordInSession: false,
        response:
          `${statusLine(ctx.workspacePath, ctx.session?.mode ?? ("agent" as SessionMode))}\n` +
          (modelLevels
            ? `Levels for ${model}: ${modelLevels.join(" · ")}\n`
            : `Levels: ${levels.join(" · ")}\n`) +
          `  Type the level itself, e.g. /think low — the brackets are a placeholder.`,
      };
    }

    if (CLEARERS.has(arg)) {
      setThinkingOverride(undefined);
      return { success: true, recordInSession: false, response: statusLine(ctx.workspacePath, ctx.session?.mode ?? ("agent" as SessionMode)) };
    }

    if (!levels.includes(arg)) {
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] '${arg}' is not a valid level.\n` +
          // Show the ACTIVE model's levels, not the global set — offering six when the model takes
          // three is what sends a user to try one that gets dropped.
          (modelLevels
            ? `Levels for ${model}: ${modelLevels.join(" · ")}`
            : `Levels: ${levels.join(" · ")}`) +
          `  ·  /think off clears the override`,
      };
    }

    if (map && mapThinkingLevel(arg, map) === undefined) {
      // Accepting it would be the exact failure this exists to prevent: the request goes out, the
      // backend drops it, and the level reads as applied.
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] ${model} does not support '${arg}' — it would be ignored.\n` +
          `Levels for this model: ${(modelLevels ?? levels).join(" · ")}`,
      };
    }

    const translated = mapThinkingLevel(arg, map);
    setThinkingOverride(arg);
    return {
      success: true,
      recordInSession: false,
      // "sent", not "applied": the backend decides whether to honor it.
      response:
        `[REI] Thinking: ${arg}` +
        (translated && translated !== arg ? ` → sent as '${translated}' for ${model}` : "") +
        ` — sent from the next turn on (the backend decides whether to honor it).`,
    };
  },
};
