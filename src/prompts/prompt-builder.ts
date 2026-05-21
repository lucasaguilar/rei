import type { SessionMode } from "../chat/types.js";
import { loadLocalRules, loadPrompt } from "./loader.js";
import { detectProjectType } from "../workspace/project-type.js";

export type AgentEditFormat = "sr" | "wholefile";

export function getAgentEditFormat(): AgentEditFormat {
  const val = (process.env.AGENT_EDIT_FORMAT ?? "sr").toLowerCase().trim();
  return val === "wholefile" ? "wholefile" : "sr";
}

const ANGULAR_RULES = `### Angular Project Rules (mandatory — violations are bugs):
- Control flow: use \`@if\`, \`@for (item of list; track item.id)\`, \`@switch\`. NEVER use *ngIf, *ngFor, *ngSwitch.
- Components: always \`standalone: true\` and \`ChangeDetectionStrategy.OnPush\`.
- Inputs: use \`input()\` or \`input.required<T>()\`. NEVER use the \`@Input()\` decorator.
- Outputs: use \`output<T>()\`. NEVER use \`@Output()\` or \`EventEmitter\`.
- Reactivity: use \`signal()\`, \`computed()\`, \`effect()\` from \`@angular/core\`.
- Dependency injection: use \`inject()\`. NEVER use constructor parameter injection.
- Async: \`async/await\` for one-off HTTP calls. Observables only for streams.
- Strict types: no \`any\`. Use TypeScript strict mode.`;

function buildProjectRules(workspacePath?: string): string {
  const wsPath = workspacePath ?? process.env.REI_WORKSPACE_PATH;
  if (!wsPath) return "";
  const { type } = detectProjectType(wsPath);
  if (type === "angular") return ANGULAR_RULES;
  return "";
}

export function buildSystemMessage(
  mode: SessionMode,
  workspacePath?: string,
): string {
  const projectRules = buildProjectRules(workspacePath);

  const sections: string[] = [
    loadPrompt("shared/base"),
    "",
    `Active mode: ${mode}`,
    "",
    loadPrompt("shared/response-rules"),
    "",
    // Project-type rules (Angular, etc.) injected before local overrides
    ...(projectRules ? [projectRules, ""] : []),
    // Per-workspace and global custom rules (highest priority)
    loadLocalRules(workspacePath),
    "",
  ];

  if (mode === "agent") {
    const fmt = getAgentEditFormat();
    if (fmt === "wholefile") {
      sections.push(loadPrompt("modes/agent-wholefile"), "");
      sections.push(loadPrompt("formats/agent-format-wholefile"));
    } else {
      sections.push(loadPrompt("modes/agent"), "");
      sections.push(loadPrompt("formats/agent-format"));
    }
  } else {
    sections.push(loadPrompt(`modes/${mode}`), "");
    sections.push(loadPrompt(`formats/${mode}-format`));
  }

  return sections.join("\n");
}
