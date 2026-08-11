import type { CommandHandler, CommandResult } from "./command-handler.js";
import { loadRole, listRoles } from "../../skills/role-loader.js";
import { saveSession } from "../session-store.js";

/**
 * `/role <name>` activates a data-driven role (posture), `/role off` clears it, `/roles` lists them.
 * A role layers a posture onto a permission profile (its `baseMode`) — it is NOT a 4th core mode.
 * See docs/roles-spec.md.
 */
const ROLE_RE = /^\/role\s+(\S+)$/i;

export const roleCommands: CommandHandler = {
  match: (c) => c === "/roles" || ROLE_RE.test(c),

  run: ({ command, session, workspacePath }): CommandResult => {
    if (command.trim() === "/roles") {
      const roles = listRoles(workspacePath);
      if (roles.length === 0) {
        return { success: true, recordInSession: false, response: "[REI] No roles found in prompts/roles/ or .rei/roles/." };
      }
      const lines = roles.map(
        (r) => `  ${r.name === session.activeRole ? "▶" : " "} ${r.name} — ${r.description}`,
      );
      const header = session.activeRole ? `Active role: ${session.activeRole}` : "No active role.";
      return {
        success: true,
        recordInSession: false,
        response: `[REI] ${header}\nAvailable roles:\n${lines.join("\n")}`,
      };
    }

    const m = command.match(ROLE_RE);
    const arg = m![1].toLowerCase();

    if (arg === "off" || arg === "clear" || arg === "none") {
      saveSession(workspacePath, session.messages, session.mode, session.summary, session.createdAt);
      return {
        success: true,
        response: "[REI] Role cleared — back to the plain mode.",
        newSession: { ...session, activeRole: undefined },
      };
    }

    const role = loadRole(arg, workspacePath);
    if (!role) {
      const names = listRoles(workspacePath).map((r) => r.name).join(", ") || "(none)";
      return {
        success: false,
        response: `[REI] Unknown role '${arg}'. Available: ${names}. (List with /roles.)`,
      };
    }

    // Activating a role adopts its permission profile (baseMode) + its posture (activeRole).
    saveSession(workspacePath, session.messages, role.baseMode, session.summary, session.createdAt);
    const modelHint = role.preferredModel
      ? ` Suggested model for this role: ${role.preferredModel} (load it in LM Studio).`
      : "";
    return {
      success: true,
      response:
        `[REI] Role '${role.name}' active (${role.baseMode} profile). ${role.description}.${modelHint}\n` +
        `Point it at a document with @ (e.g. /role auditor → "audit @.rei/plans/my-plan.md").`,
      newSession: { ...session, mode: role.baseMode, activeRole: role.name },
    };
  },
};
