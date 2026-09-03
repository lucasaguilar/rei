import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandContext, CommandHandler, CommandResult } from "./command-handler.js";
import { saveSession } from "../session-store.js";
import { isSpecMessage } from "../spec-tracker.js";
import { findSkill, loadSkills } from "../../skills/skill-loader.js";
import { getActive, setActivePlan, setActiveSpec } from "../active-artifacts.js";
import type { SessionMode } from "../types.js";

/**
 * `/spec <task>` and `/decompose` — the two phases of the spec-driven flow, made deterministic.
 *
 * Skills are OFFERED to the model, never imposed: it sees a catalog and decides. A local model
 * asked to "plan X" routinely skips `write-spec` and answers with a plan, so `/savespec` then finds
 * no spec to save — the flow was a convention, not a mechanism.
 *
 * These commands close that gap the way `/runplan` already does: instead of asking the model to load
 * a skill, they inject the skill's BODY into the prompt and hand it to the turn pipeline via
 * `autoExecute`. The model cannot skip a recipe that is already in its context.
 *
 * They deliberately stay two separate steps, not one `/sdd`: the spec is a contract worth reading and
 * correcting before anything is decomposed against it.
 */

const SPEC_RE = /^\/spec\s+(.+)$/is;
const DECOMPOSE_RE = /^\/decompose\s*$/i;

/** A short, filesystem-safe name derived from the task — the spec and its plan share it. */
function slug(task: string): string {
  const base = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-");
  return base.length > 0 ? base.slice(0, 48) : "spec";
}

/** Loads a skill's full body, or null when it isn't installed. */
function skillBody(workspacePath: string, name: string): string | null {
  const skill = findSkill(loadSkills(workspacePath), name);
  return skill?.body ?? null;
}

function missingSkill(name: string): CommandResult {
  return {
    success: false,
    recordInSession: false,
    response:
      `[REI] The '${name}' skill was not found in prompts/skills/ or .rei/skills/. ` +
      `It is required for this step.`,
  };
}

/** The most recent spec in the session, else the newest file in `.rei/specs/`. */
function findSpec(ctx: CommandContext): { content: string; origin: string } | null {
  const inSession = [...ctx.session.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content && isSpecMessage(m.content));
  if (inSession?.content) return { content: inSession.content, origin: "this session" };

  const dir = path.join(ctx.workspacePath, ".rei", "specs");
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (!newest) return null;
    return {
      content: fs.readFileSync(path.join(dir, newest.f), "utf8"),
      origin: `.rei/specs/${newest.f}`,
    };
  } catch {
    return null; // no specs dir yet
  }
}

export const sddCommands: CommandHandler = {
  match: (c) => SPEC_RE.test(c.trim()) || DECOMPOSE_RE.test(c.trim()),

  run: (ctx): CommandResult => {
    const { command, session, workspacePath } = ctx;
    const trimmed = command.trim();
    const planning = "planning" as SessionMode;

    // ── /spec <task> ────────────────────────────────────────────────────────
    const specMatch = trimmed.match(SPEC_RE);
    if (specMatch) {
      const task = specMatch[1].trim();
      const body = skillBody(workspacePath, "write-spec");
      if (!body) return missingSkill("write-spec");

      // The COMMAND picks the name and marks it active, then tells the model exactly where to write.
      // Letting the model choose would leave REI guessing which file it meant — the ambiguity the
      // active pointer exists to remove.
      const specName = slug(task);
      setActiveSpec(workspacePath, specName);

      const prompt =
        `[SPEC] Write the spec for this request. This is the SPEC step — not a plan, not code.\n\n` +
        `REQUEST:\n${task}\n\n` +
        `Follow this recipe exactly:\n\n${body}\n\n` +
        `⚙️ Ground the spec in the real code first (read_files / grep_code), then emit ONLY the spec ` +
        `in the format above. Do NOT decompose it into stages and do NOT implement anything. ` +
        `Also save it with create_file to .rei/specs/${specName}.md — that exact path — so it survives ` +
        `this session and REI knows which spec is active.`;

      saveSession(workspacePath, session.messages, planning, session.summary, session.createdAt);
      return {
        success: true,
        response: `[REI] Switching to PLANNING mode to write the spec → .rei/specs/${specName}.md (now the active spec).`,
        newSession: { ...session, mode: planning },
        autoExecute: { prompt },
      };
    }

    // ── /decompose ──────────────────────────────────────────────────────────
    const spec = findSpec(ctx);
    if (!spec) {
      // Refusing beats planning without a contract: a plan built from a vague prompt is exactly the
      // scope drift the spec exists to prevent.
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] No spec found in this session or in .rei/specs/.\n` +
          `Run /spec <task> first, or /loadspec <name> to bring an existing one in.`,
      };
    }

    const body = skillBody(workspacePath, "micro-task-decomposition");
    if (!body) return missingSkill("micro-task-decomposition");

    // The plan inherits the spec's name, so the pair is obvious on disk and `/runplan` has an active
    // plan without anyone remembering to `/saveplan`.
    const planName = getActive(workspacePath).spec ?? "current";
    setActivePlan(workspacePath, planName);

    const prompt =
      `[DECOMPOSE] Turn this spec into an implementation plan. This is the PLAN step — do not implement.\n\n` +
      `SPEC (from ${spec.origin}):\n${spec.content}\n\n` +
      `Follow this recipe exactly:\n\n${body}\n\n` +
      `⚙️ Emit ONLY the plan. Every stage carries a \`Satisfies:\` line naming the acceptance ` +
      `criterion it serves, and the plan closes with the two verification stages the recipe requires. ` +
      `Save the plan with create_file to .rei/plans/${planName}.md — that exact path, so /runplan ` +
      `picks it up. Do NOT edit source files — this step produces the plan, not the change.`;

    saveSession(workspacePath, session.messages, planning, session.summary, session.createdAt);
    return {
      success: true,
      response:
        `[REI] Switching to PLANNING mode to decompose the spec (${spec.origin}) ` +
        `→ .rei/plans/${planName}.md (now the active plan).`,
      newSession: { ...session, mode: planning },
      autoExecute: { prompt },
    };
  },
};
