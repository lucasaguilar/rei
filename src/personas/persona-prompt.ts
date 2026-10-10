import * as path from "node:path";
import { buildCurrentDateLine } from "../prompts/prompt-builder.js";
import type { Persona } from "./persona-loader.js";

/**
 * The system prompt of a persona turn (docs/persona-spec.md, phase 2). Used INSTEAD of
 * buildSystemMessage: none of REI's coding prompt — base identity, personality, response rules,
 * the workspace's code rules, the mode's tool instructions — reaches it. A sales assistant told
 * "you are a repository-aware coding agent" and "a senior dev, not a support bot" answers like one.
 *
 * Order (the spec's): channel policy → persona → knowledge → tools → reply rules → date. The policy
 * goes first so nothing a persona says can come before the rules a public channel imposes.
 */

export interface PersonaPromptContext {
  /** The tools this turn actually offers — already persona ∩ surface (resolvePersonaTools). */
  tools: readonly string[];
  workspacePath: string;
  /** A public channel's rules (e.g. WhatsApp's guardrails); absent in the CLI. */
  channelPolicy?: string;
  /** The skills use_skill can load this turn (already resolved). */
  skillNames?: readonly string[];
  now?: Date;
}

const READ_TOOLS = ["read_files", "grep_code", "list_files"];

export function buildPersonaSystemMessage(persona: Persona, ctx: PersonaPromptContext): string {
  const sections: string[] = [];
  if (ctx.channelPolicy?.trim()) sections.push(ctx.channelPolicy.trim());
  sections.push(persona.body);

  const knowledge = knowledgeSection(persona, ctx);
  if (knowledge) sections.push(knowledge);
  sections.push(toolsSection(ctx.tools));
  const writing = writingSection(persona, ctx.tools);
  if (writing) sections.push(writing);
  if (ctx.skillNames?.length && ctx.tools.includes("use_skill")) {
    sections.push(
      `## Skills\nRecipes you can load with use_skill: ${ctx.skillNames.join(", ")}. When a request ` +
        `matches one, load it first and follow it.`,
    );
  }
  sections.push(replyRules(persona));
  sections.push(buildCurrentDateLine(ctx.now));
  return `${sections.join("\n\n")}\n`;
}

function knowledgeSection(persona: Persona, ctx: PersonaPromptContext): string | null {
  const readers = READ_TOOLS.filter((t) => ctx.tools.includes(t));
  if (readers.length === 0) return null;
  // Workspace-relative on purpose: an absolute path names the host's directory layout, and a
  // channel's user can try to get the prompt repeated back.
  const where = persona.knowledgeDir
    ? `the files under ${path.relative(ctx.workspacePath, persona.knowledgeDir) || "."}`
    : "the workspace";
  return (
    `## Knowledge base\n` +
    `Answer from your knowledge base: ${where}. Look it up with ${readers.join(", ")} before ` +
    `answering, and do not answer from memory what the knowledge base can tell you.`
  );
}

function toolsSection(tools: readonly string[]): string {
  if (tools.length === 0) {
    return "## Tools\nYou have no tools: answer from this conversation and what you were told above.";
  }
  return (
    `## Tools\nYou can use: ${tools.join(", ")}. You have no other tools — never claim a result you ` +
    `did not get from one of them. When you decide to use a tool, call it in the same response ` +
    `instead of announcing that you will.`
  );
}

function writingSection(persona: Persona, tools: readonly string[]): string | null {
  if (!persona.writeGlob) return null;
  if (!tools.some((t) => t === "create_file" || t === "edit_file" || t === "rewrite_file")) return null;
  return (
    `## Writing\nYou may create or edit only files matching ${persona.writeGlob}. A write anywhere ` +
    `else is refused — do not attempt it, and never claim a file was saved unless the tool said so.`
  );
}

function replyRules(persona: Persona): string {
  const rules = [
    persona.language === "auto"
      ? "Reply in the language of the user's last message."
      : `Always reply in ${persona.language}, whatever language the user writes in.`,
  ];
  if (persona.maxReplyChars) {
    rules.push(`Keep each reply under about ${persona.maxReplyChars} characters.`);
  }
  rules.push(
    "If you do not know, say so — never invent facts, prices, dates or contact details.",
    `When a request is outside your scope, or the answer is not available to you, say so plainly ` +
      `and give this hand-off: ${persona.handoff}`,
  );
  return `## Replies\n${rules.map((r) => `- ${r}`).join("\n")}`;
}
