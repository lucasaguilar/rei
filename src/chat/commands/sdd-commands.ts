import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandContext, CommandHandler, CommandResult } from "./command-handler.js";
import { saveSession } from "../session-store.js";
import { isSpecMessage } from "../spec-tracker.js";
import { findSkill, loadSkills } from "../../skills/skill-loader.js";
import { getActive, setActivePlan, setActiveSpec } from "../active-artifacts.js";
import type { SessionMode } from "../types.js";
import { newElicitationId } from "../elicitation.js";

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

/**
 * Words that carry no meaning in a file name. Two languages because the tasks are written in two.
 */
const STOPWORDS = new Set([
  "el","la","los","las","un","una","unos","unas","de","del","al","a","en","y","o","que","para",
  "por","con","sin","su","sus","mi","lo","se","es","son","este","esta","esto","ese","esa","como",
  "the","a","an","of","to","in","on","for","and","or","that","this","with","from","is","are","it",
]);

/**
 * A short, filesystem-safe name proposed for a spec (and the plan that follows it).
 *
 * The old version lowercased, deleted every non-letter and took the first FIVE words — which meant
 * articles and prepositions ate the budget ("arreglar-el-bug-del-context") and, because `/` and `.`
 * were deleted rather than treated as separators, a path pasted into the task collapsed into one
 * 48-char token: `usersdevwwwprclient-webclient-appcursorplansci`. The date goes in front so the
 * directory sorts chronologically, which is how you actually look for one of these later.
 */
export function proposeName(task: string, today = new Date()): string {
  const date = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");

  const words = task
    .toLowerCase()
    // Separators, not characters to delete: a path must break into its parts, not fuse into one.
    .replace(/[/\\._:@]+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    // A pasted path leaves its directories behind; they describe where, never what.
    .filter((w) => !["users","home","www","src","tmp","var","dev"].includes(w));

  const slug = words.slice(0, 4).join("-").slice(0, 32).replace(/-+$/, "");
  return `${date}-${slug || "spec"}`;
}

/** Strips anything that could escape `.rei/specs/`, and normalises what the user typed. */
export function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
}

/**
 * Lets the user name the artifact, proposing one derived from the task.
 *
 * REI picks the path the model must write to, so the name is REI's decision — but it is the user
 * who has to find the file next week. Without an interactive frontend the proposal stands, so
 * one-shot and server runs are unaffected.
 */
async function askForName(
  ctx: CommandContext,
  proposed: string,
  what: "spec" | "plan",
): Promise<string> {
  if (!ctx.elicit) return proposed;
  const answer = await ctx.elicit({
    id: newElicitationId(),
    kind: "text",
    message: `Name for the ${what} (Enter keeps "${proposed}") → .rei/${what}s/<name>.md`,
    default: proposed,
  });
  return sanitizeName(answer.value) || proposed;
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

  run: async (ctx): Promise<CommandResult> => {
    const { command, session, workspacePath } = ctx;
    const trimmed = command.trim();
    const planning = "planning" as SessionMode;

    // ── /spec <task> ────────────────────────────────────────────────────────
    const specMatch = trimmed.match(SPEC_RE);
    if (specMatch) {
      const task = specMatch[1].trim();
      const body = skillBody(workspacePath, "write-spec");
      if (!body) return missingSkill("write-spec");

      // The COMMAND owns the path — letting the model choose leaves REI guessing which file it
      // meant, the ambiguity the active pointer exists to remove. But the NAME is offered to the
      // user first: they are the one who has to find this file next week.
      const specName = await askForName(ctx, proposeName(task), "spec");
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

    // The plan is OFFERED the spec's name, so the pair stays obvious on disk and `/runplan` has an
    // active plan without anyone remembering to `/saveplan` — but it is still the user's to change.
    const planName = await askForName(
      ctx,
      getActive(workspacePath).spec ?? proposeName(spec.origin),
      "plan",
    );
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
