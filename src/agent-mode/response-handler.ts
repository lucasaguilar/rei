import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { stripThinkingBlock } from "../core/helpers/turn-message.helpers.js";

function normalizeBlockContent(raw: string): string {
  let content = raw.replace(/\r\n/g, "\n");

  // Models sometimes wrap search/replace bodies in markdown fences.
  content = content.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n/, "");
  content = content.replace(/\n\s*```\s*$/, "");
  content = content.replace(/^\s*```[a-zA-Z0-9_-]*\s*/, "");
  content = content.replace(/\s*```\s*$/, "");

  // Ensure consistent backslash handling to prevent accumulation
  content = content.replace(/\\\\/g, "\\"); // Normalize double backslashes

  return content.replace(/^\n/, "").replace(/\n$/, "");
}




/**
 * Extracts <edit> blocks representing Search & Replace operations.
 */
export function extractSREdits(response: string): AgentSREdit[] {
  const edits: AgentSREdit[] = [];
  const editRegex = /<edit\s+file="([^"]+)">([\s\S]*?)<\/edit>/gi;
  const matches = [...stripThinkingBlock(response).matchAll(editRegex)];

  for (const match of matches) {
    const file = match[1].trim();
    const inner = match[2];

    const searchMatch = inner.match(/<search>([\s\S]*?)<\/search>/i);
    const replaceMatch = inner.match(
      /<replace>([\s\S]*?)(?:<\/replace>|<\/search>|$)/i,
    );

    if (searchMatch && replaceMatch) {
      edits.push({
        file,
        description: "Search and replace block",
        search: normalizeBlockContent(searchMatch[1]),
        replace: normalizeBlockContent(replaceMatch[1]),
      });
    }
  }
  return edits;
}

/**
 * Extracts <create file="...">...</create> blocks for file creation.
 */
export function extractCreateFileRequests(
  response: string,
): Array<{ file: string; content: string }> {
  const creates: Array<{ file: string; content: string }> = [];
  const createRegex = /<create\s+file="([^"]+)">([\s\S]*?)<\/create>/gi;
  const matches = [...response.matchAll(createRegex)];
  for (const match of matches) {
    const file = match[1].trim();
    const content = normalizeBlockContent(match[2]);
    creates.push({ file, content });
  }
  return creates;
}


function normalizeCommandContent(raw: string): string {
  let content = raw.replace(/\r\n/g, "\n").trim();

  // Strip markdown code block fences (e.g. ```bash ... ```)
  content = content.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n/, "");
  content = content.replace(/\n\s*```\s*$/, "");
  content = content.replace(/^\s*```[a-zA-Z0-9_-]*\s*/, "");
  content = content.replace(/\s*```\s*$/, "");

  content = content.trim();

  // Strip leading and trailing single backticks (e.g. `some command`, `git status, git status`)
  // Be aggressive: stripea backticks del inicio Y final, aunque no haya en ambos lados.
  // Esto previene el error "Security Error: Command '`' is not in the allow-list"
  // que ocurre cuando el modelo emite `git status (backtick solo al inicio).
  while (content.startsWith("`") || content.endsWith("`")) {
    if (content.startsWith("`")) {
      content = content.slice(1);
    }
    if (content.endsWith("`")) {
      content = content.slice(0, -1);
    }
  }
  content = content.trim();

  return content;
}

/**
 * Extracts <execute_command> tags from the agent response.
 */
export function extractCommandRequests(response: string): string[] {
  // Strip thinking blocks first — the model sometimes closes </think> inside
  // an <execute_command> tag, causing the entire reasoning trace to be captured
  // as the command string instead of the actual command.
  const clean = stripThinkingBlock(response);
  const matches = [...clean.matchAll(/<execute_command>([\s\S]*?)<\/execute_command>/gi)];
  return matches.map((match) => normalizeCommandContent(match[1]));
}

/**
 * Extrae llamadas a herramientas con el patrón XML <call_tool name="name">args</call_tool>
 * Ejemplo: <call_tool name="weather">London</call_tool> o <call_tool name="weather">{"location": "London"}</call_tool>
 */
export function extractToolCalls(
  response: string,
): Array<{ name: string; args: Record<string, unknown> }> {
  const matches = [
    ...stripThinkingBlock(response).matchAll(
      /<call_tool\s+name="([^"]+)">([\s\S]*?)<\/call_tool>/gi,
    ),
  ];

  return matches.map((match) => {
    const name = match[1].trim();
    const argsStr = match[2].trim();
    let args: Record<string, unknown> = {};

    try {
      if (argsStr.startsWith("{")) {
        args = JSON.parse(argsStr) as Record<string, unknown>;
      } else {
        const cleanArg = argsStr.replace(/^["']|["']$/g, "");
        if (name === "weather") {
          args = { location: cleanArg };
        } else if (name === "search") {
          args = { query: cleanArg };
        } else {
          args = { input: cleanArg };
        }
      }
    } catch (e) {
      args = { input: argsStr };
    }

    return { name, args };
  });
}
