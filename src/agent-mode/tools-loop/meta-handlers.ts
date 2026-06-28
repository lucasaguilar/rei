import type { AgentLogger } from "../../core/logger.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";
import type { Skill } from "../../skills/skill-loader.js";
import { searchMcpTools, SEARCH_K } from "../../tools/tool-retriever.js";
import { findSkill } from "../../skills/skill-loader.js";

type McpTool = ReturnType<McpRegistry["getAvailableTools"]>[number];

interface StatusCtx {
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
}

/**
 * search_tools (meta-tool): find MCP tools by keyword and ACTIVATE them so the model can call them
 * directly next turn. Mutates `activeMcp` by reference (so buildTools exposes them). Extracted from
 * executeAgentTurnWithTools (Phase 2).
 */
export function handleSearchTools(
  query: string,
  ctx: StatusCtx & { allMcpTools: McpTool[]; activeMcp: Set<string> },
): string {
  const found = searchMcpTools(query, ctx.allMcpTools, SEARCH_K);
  found.forEach((t) => ctx.activeMcp.add(t.name));
  ctx.logger.logInfo(`[tools] search_tools: "${query}"`, { found: found.map((t) => t.name) });
  ctx.emitStatus(`🧰  [REI] Searching tools: ${query}`);
  return found.length
    ? "Loaded these tools — you can now call them directly:\n" +
        found.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n")
    : `No tools matched "${query}". Try different keywords.`;
}

/**
 * use_skill (meta-tool): load a reusable task recipe's full body into the conversation so the model
 * follows its steps. The catalog (name+description) already rode in the tool; this injects the body.
 */
export function handleUseSkill(name: string, ctx: StatusCtx & { skills: Skill[] }): string {
  const skill = findSkill(ctx.skills, name);
  ctx.logger.logInfo(`[tools] use_skill: "${name}"`, { matched: skill?.name ?? null });
  ctx.emitStatus(`📘  [REI] Loading skill: ${skill?.name ?? name}`);
  return skill
    ? `Skill "${skill.name}" loaded — follow these steps:\n\n${skill.body}`
    : `No skill named "${name}". Available: ${ctx.skills.map((s) => s.name).join(", ") || "(none)"}.`;
}
