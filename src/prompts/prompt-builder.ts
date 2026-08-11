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
- Strict types: no \`any\`. Use TypeScript strict mode.
- Atomicity (planning): a component (class + template + styles) is ONE atomic unit — never split its
  files across separate stages. An orphan \`.html\`/\`.scss\` without its \`.ts\` gives a false-green
  \`ngc\` check, because the template is only type-validated once the component class references it.`;

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
  roleBody?: string,
): string {
  const projectRules = buildProjectRules(workspacePath);

  // Current date — the model has a training cutoff and otherwise hallucinates
  // "today", breaking date-relative tasks (e.g. "today's emails", "last week").
  const now = new Date();
  const isoDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const currentDateLine = `Current date: ${weekday}, ${isoDate} (user's local time). Use this for any date-relative request; do not guess the date.`;

  const sections: string[] = [
    loadPrompt("shared/base"),
    "",
    // Active role posture (auditor, security, …) — high priority, right after the base identity so it
    // overrides the default helpful/agreeable stance. See docs/roles-spec.md.
    ...(roleBody ? [`## ACTIVE ROLE (overrides default posture)\n${roleBody}`, ""] : []),
    loadPrompt("shared/personality"),
    "",
    currentDateLine,
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

  // Native function-calling is the only engine (the XML interception path was removed), so every
  // mode uses its `*-tools` prompt: native read_files/run_command/edit_file tool calls, NO XML tags.
  // For agent, the tool prompt + its tool-format; for ask/planning, the tool prompt + the
  // tool-agnostic response-format prompt. Skills ride as the native `use_skill` tool (from
  // setupToolSelection), so no XML `<call_tool>` skill catalog is injected.
  if (mode === "agent") {
    sections.push(loadPrompt("modes/agent-tools"), "");
    sections.push(loadPrompt("formats/agent-format-tools"));
  } else {
    sections.push(loadPrompt(`modes/${mode}-tools`), "");
    sections.push(loadPrompt(`formats/${mode}-format`));
  }

  return sections.join("\n");
}
