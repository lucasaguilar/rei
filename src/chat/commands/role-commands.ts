import type { CommandHandler, CommandResult } from "./command-handler.js";
import { loadRole, listRoles } from "../../skills/role-loader.js";
import { saveSession } from "../session-store.js";
import { RESERVED_COMMAND_NAMES } from "./role-agent-commands.js";
import { scaffoldRole } from "../../skills/role-scaffold.js";

/**
 * `/role <name>` activates a data-driven role (posture), `/role off` clears it, `/roles` lists them.
 * A role layers a posture onto a permission profile (its `baseMode`) — it is NOT a 4th core mode.
 * See docs/roles-spec.md.
 */
const ROLE_RE = /^\/role\s+(\S+)$/i;
/**
 * `/role <name> <task>` — the form everyone reaches for first, and the one that does not exist.
 *
 * The two invocations differ by more than an argument: `/role auditor` puts the posture on THIS
 * session, `/auditor <task>` runs it in an isolated one. Left unmatched this fell through to
 * "Unknown command", which is true and teaches nothing — so it is claimed here purely to say which
 * of the two you meant.
 */
const ROLE_WITH_TASK_RE = /^\/role\s+(\S+)\s+(\S[\s\S]*)$/i;
const NEW_RE = /^\/roles\s+new(?:\s+(\S+))?$/i;

export const roleCommands: CommandHandler = {
  match: (c) => c === "/roles" || NEW_RE.test(c) || ROLE_RE.test(c) || ROLE_WITH_TASK_RE.test(c),

  run: ({ command, session, workspacePath }): CommandResult => {
    const withTask = command.match(ROLE_WITH_TASK_RE);
    if (withTask) {
      const [, name, task] = withTask;
      const known = loadRole(name, workspacePath);
      const slug = known?.name ?? name;
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] /role takes a role name and nothing else. Two different things you might mean:\n\n` +
          `  /role ${slug}\n` +
          `      Wear the role in THIS session. Then just type "${task}" as a normal message —\n` +
          `      it keeps your context and you can keep going back and forth with it.\n\n` +
          `  /${slug} ${task}\n` +
          `      Run it as a sub-agent in a CLEAN context. One shot, returns a report, your\n` +
          `      session is untouched. It cannot see this conversation, which is why the task\n` +
          `      goes on the same line.` +
          (known ? "" : `\n\n(There is no role called '${name}' — /roles lists what there is.)`),
      };
    }

    const newMatch = command.match(NEW_RE);
    if (newMatch) {
      const name = newMatch[1];
      if (!name) {
        return {
          success: false,
          recordInSession: false,
          response: "[REI] /roles new <name> — e.g. /roles new security-reviewer",
        };
      }
      const created = scaffoldRole(name, workspacePath, (n) => RESERVED_COMMAND_NAMES.has(n));
      if (!created.ok) {
        return { success: false, recordInSession: false, response: `[REI] ${created.error}` };
      }
      const slug = name.trim().toLowerCase();
      return {
        success: true,
        recordInSession: false,
        response:
          `[REI] Created ${created.file}. Edit it, then invoke it either way:\n` +
          `  /role ${slug}          — wear it in THIS session (shared context)\n` +
          `  /${slug} <task>        — run it isolated (clean context, returns a report)`,
      };
    }

    if (command.trim() === "/roles") {
      const roles = listRoles(workspacePath);
      if (roles.length === 0) {
        return { success: true, recordInSession: false, response: "[REI] No roles found in prompts/roles/ or .rei/roles/." };
      }
      // Each role is listed with BOTH ways to invoke it. Without this nobody discovers the
      // isolated form: `/auditor` is a command only because a file says so, so it appears in no
      // static command list and in no tab-completion.
      const lines = roles.map((r) => {
        const active = r.name === session.activeRole ? "▶" : " ";
        const shadowed = RESERVED_COMMAND_NAMES.has(r.name.toLowerCase())
          ? `      ⚠ '${r.name}' is also a built-in command, so /${r.name} runs that instead — rename the role to invoke it isolated.`
          : `      /role ${r.name} (here) · /${r.name} <task> (isolated${r.preferredModel ? `, ${r.preferredModel}` : ""})`;
        return `  ${active} ${r.name} — ${r.description}\n${shadowed}`;
      });
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
      // Restore only if you are STILL in the mode the role put you in. An explicit /mode while a
      // role was active is a decision, and silently undoing it is worse than not restoring at all.
      const leaving = session.activeRole ? loadRole(session.activeRole, workspacePath) : null;
      const restored =
        session.rolePreviousMode && session.mode === leaving?.baseMode
          ? session.rolePreviousMode
          : session.mode;
      saveSession(workspacePath, session.messages, restored, session.summary, session.createdAt);
      const note = restored !== session.mode ? ` Back to ${restored} mode.` : "";
      return {
        success: true,
        response: `[REI] Role cleared.${note}`,
        newSession: {
          ...session,
          mode: restored,
          activeRole: undefined,
          rolePreviousMode: undefined,
        },
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
    // Where you were is recorded on the FIRST activation only: swapping auditor → security must
    // not overwrite it with the mode the previous role had already imposed.
    const previousMode = session.activeRole ? session.rolePreviousMode : session.mode;
    saveSession(workspacePath, session.messages, role.baseMode, session.summary, session.createdAt);
    const modelHint = role.preferredModel
      ? ` Runs on ${role.preferredModel}.`
      : "";
    return {
      success: true,
      response:
        `[REI] Role '${role.name}' active (${role.baseMode} profile). ${role.description}.${modelHint}\n` +
        `Point it at a document with @ (e.g. "audit @.rei/plans/my-plan.md"), or run it in an ` +
        `isolated context instead with /${role.name} <task>.`,
      newSession: {
        ...session,
        mode: role.baseMode,
        activeRole: role.name,
        rolePreviousMode: previousMode,
      },
    };
  },
};
