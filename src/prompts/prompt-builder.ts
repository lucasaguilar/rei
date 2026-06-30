import type { SessionMode } from "../chat/types.js";
import { loadLocalRules, loadPrompt } from "./loader.js";
import { detectProjectType } from "../workspace/project-type.js";
import {
  loadSkills,
  skillsForMode,
  buildSkillCatalogText,
  type SkillMode,
} from "../skills/skill-loader.js";

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

/** Builds the mode-scoped skill catalog text for the XML (ask/planning) path. */
function buildModeSkillCatalog(
  mode: SessionMode,
  workspacePath?: string,
): string {
  const wsPath = workspacePath ?? process.env.REI_WORKSPACE_PATH;
  if (!wsPath) return "";
  const skills = skillsForMode(loadSkills(wsPath), mode as SkillMode);
  return buildSkillCatalogText(skills);
}

export function buildSystemMessage(
  mode: SessionMode,
  workspacePath?: string,
  useToolCalling = false,
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

  if (mode === "agent") {
    if (useToolCalling) {
      sections.push(loadPrompt("modes/agent-tools"), "");
      sections.push(loadPrompt("formats/agent-format-tools"));
    } else {
      const fmt = getAgentEditFormat();
      if (fmt === "wholefile") {
        sections.push(loadPrompt("modes/agent-wholefile"), "");
        sections.push(loadPrompt("formats/agent-format-wholefile"));
      } else {
        sections.push(loadPrompt("modes/agent"), "");
        sections.push(loadPrompt("formats/agent-format"));
      }
    }
  } else if (useToolCalling) {
    // ask/planning on the NATIVE function-calling path: use the *-tools mode prompt (native
    // read_files/run_command, NO XML tags) so the model doesn't fall back to <request_files>/
    // <execute_command>/<call_tool> and read files with capped `cat`/`sed`. The response-format
    // prompt is tool-agnostic (just structure), so it's reused. Skills ride as the native
    // `use_skill` tool (from setupToolSelection), so the XML <call_tool> skill catalog is omitted.
    sections.push(loadPrompt(`modes/${mode}-tools`), "");
    sections.push(loadPrompt(`formats/${mode}-format`));
  } else {
    sections.push(loadPrompt(`modes/${mode}`), "");
    sections.push(loadPrompt(`formats/${mode}-format`));
    // Ask/planning use the XML path (no structured tool schema), so the skill
    // catalog rides in the prompt and the model invokes one via <call_tool
    // name="use_skill">. Only skills scoped to this mode are offered.
    const catalog = buildModeSkillCatalog(mode, workspacePath);
    if (catalog) sections.push("", catalog);
  }

  return sections.join("\n");
}
