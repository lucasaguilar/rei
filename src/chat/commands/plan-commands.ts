import type { CommandHandler, CommandResult } from "./command-handler.js";
import type { SessionMode } from "../types.js";
import { saveSession } from "../session-store.js";
import {
  saveCurrentPlanContent,
  loadCurrentPlanContent,
  savePlanToFile,
  loadPlanFromFile,
  saveReviewToFile,
  isReviewMessage,
  STAGE_REGEX,
  isPlanMessage,
} from "../plan-tracker.js";
import { buildFileMatcherRegex } from "../../language/language-capabilities.js";

/**
 * `/runplan [stage <n>]` — switch to AGENT mode and execute the active plan (whole, or one stage)
 * via `autoExecute`. Extracted verbatim from menu-command-processor (Phase 1 — no behavior change).
 */
export const runPlanCommand: CommandHandler = {
  match: (c) => c.startsWith("/runplan"),

  run: ({ command: trimmed, session, workspacePath }): CommandResult => {
    // Filter optional placeholder: [stage <num>]
    const normTrimmed = trimmed.replace(/\s+\[stage\s+<num>\]$/i, "");
    const runPlanMatch = normTrimmed.match(/^\/runplan(?:\s+(?:stage)\s+(\d+))?$/i);
    if (!runPlanMatch) {
      return {
        success: false,
        response: "[RUNPLAN] Invalid format. Use /runplan or /runplan stage <number>.",
      };
    }

    // SOURCE selection: prefer the latest plan produced in THIS session's planning turns, falling
    // back to the persisted file only when the session has none (e.g. after /session, before
    // /loadplan). We exclude `sourceMode === "agent"` so we never pick up an agent execution
    // response that happens to echo "## Stage N:" headers.
    const lastPlanMsg = [...session.messages]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" &&
          m.content &&
          m.sourceMode !== "agent" &&
          isPlanMessage(m.content),
      );
    const planContent = lastPlanMsg?.content ?? loadCurrentPlanContent(workspacePath);

    if (!planContent) {
      return { success: false, response: "[RUNPLAN] No plan was found in this session." };
    }
    let targetContent = planContent;
    let stageTitle = "";

    const stageNumStr = runPlanMatch[1];
    const stageNum = stageNumStr ? parseInt(stageNumStr, 10) : null;

    // Persist the active plan as the SOURCE fallback (used cross-session when the session has no
    // in-memory plan). No progress checklist — the agent executes holistically.
    saveCurrentPlanContent(workspacePath, planContent);

    if (stageNum !== null) {
      const lines = planContent.split("\n");

      let startIndex = -1;
      let headerLevel = 0;

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(STAGE_REGEX);
        if (m && parseInt(m[3], 10) === stageNum) {
          startIndex = i;
          headerLevel = (m[1] ?? m[2] ?? "").length;
          stageTitle = lines[i];
          break;
        }
      }

      if (startIndex === -1) {
        return {
          success: false,
          response: `[RUNPLAN] Stage ${stageNum} was not found in the plan.`,
        };
      }

      // Find the end index of the section
      let endIndex = lines.length;
      for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#")) {
          const m = line.match(STAGE_REGEX);
          const headerMatch = line.match(/^#+/);
          const matchLen = headerMatch ? headerMatch[0].length : 0;
          // Terminate if another stage is found, or a header of same/higher level is found.
          if (m || matchLen <= headerLevel) {
            endIndex = i;
            break;
          }
        }
      }

      targetContent = lines.slice(startIndex, endIndex).join("\n");
    }
    void stageTitle;

    const fileRegex = buildFileMatcherRegex();
    const files = Array.from(new Set(targetContent.match(fileRegex) || []));

    // Forces EXECUTION on /runplan: the model otherwise reads "Execute Stage N" + a plan and
    // narrates/re-plans instead of calling edit_file. This directive snaps it into acting.
    const EXECUTE_DIRECTIVE =
      "\n\n⚙️ EXECUTE NOW — this is EXECUTION, not planning. Apply the change by emitting " +
      "edit_file / create_file tool calls for the file(s) above. Do NOT write a plan, a spec, " +
      "or a prose description, and do NOT load planning skills — make the actual edits, then " +
      "verify with the project's verify command.";

    const newMode = "agent" as SessionMode;

    if (files.length === 0) {
      // No target files — action-only stage (e.g. "run npm install").
      const planPrompt =
        (stageNum
          ? `[RUNPLAN STAGE ${stageNum}] Execute Stage ${stageNum} of the implementation plan.\n\nSUB-PLAN:\n${targetContent}`
          : `Execute the following plan:\n\nPLAN:\n${planContent}`) + EXECUTE_DIRECTIVE;

      const responseMsg = stageNum
        ? `[REI] Switching to AGENT mode to execute stage ${stageNum}. No target files detected (action-only stage).`
        : `[REI] Switching to AGENT mode to execute the entire plan. No target files detected.`;

      saveSession(workspacePath, session.messages, newMode, session.summary, session.createdAt);

      return {
        success: true,
        response: responseMsg,
        newSession: { ...session, mode: newMode },
        autoExecute: { prompt: planPrompt },
      };
    }

    const planPrompt =
      (stageNum
        ? `[RUNPLAN STAGE ${stageNum}] Execute Stage ${stageNum} of the implementation plan.\n\nSUB-PLAN:\n${targetContent}\n\nFILES TO MODIFY:\n${files.join(", ")}`
        : `Execute the following plan over these files:\n\nPLAN:\n${planContent}\n\nFILES:\n${files.join(", ")}`) +
      EXECUTE_DIRECTIVE;

    const responseMsg = stageNum
      ? `[REI] Switching to AGENT mode to execute stage ${stageNum}. Target files: ${files.join(", ")}`
      : `[REI] Switching to AGENT mode to execute the entire plan. Target files: ${files.join(", ")}`;

    saveSession(workspacePath, session.messages, newMode, session.summary, session.createdAt);

    return {
      success: true,
      response: responseMsg,
      newSession: { ...session, mode: newMode },
      autoExecute: { prompt: planPrompt },
    };
  },
};

/**
 * `/saveplan <name>` · `/loadplan <name>` — persist/ingest a full plan for cross-session reuse.
 * Extracted verbatim from menu-command-processor (Phase 1 — no behavior change).
 */
export const planFileCommands: CommandHandler = {
  match: (c) =>
    c.startsWith("/saveplan") ||
    c.startsWith("/loadplan") ||
    c.startsWith("/savereview"),

  run: ({ command: trimmed, session, workspacePath }): CommandResult => {
    if (trimmed.startsWith("/savereview")) {
      const m = trimmed.match(/^\/savereview\s+(\S+)$/i);
      if (!m) {
        return { success: false, response: "[REI] Invalid format. Use: /savereview <name>" };
      }
      const name = m[1];
      // The review is the most recent assistant message that looks like an auditor review.
      const lastReview = [...session.messages]
        .reverse()
        .find((msg) => msg.role === "assistant" && msg.content && isReviewMessage(msg.content));
      if (!lastReview || !lastReview.content) {
        return {
          success: false,
          response:
            "[REI] No review found in this session. Run the auditor first (/role auditor → audit a plan).",
        };
      }
      try {
        const savedPath = saveReviewToFile(workspacePath, name, lastReview.content);
        return { success: true, response: `[REI] Review saved to: ${savedPath}` };
      } catch (err) {
        return {
          success: false,
          response: `[REI] Error saving review: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (trimmed.startsWith("/saveplan")) {
      const saveMatch = trimmed.match(/^\/saveplan\s+(\S+)$/i);
      if (!saveMatch) {
        return { success: false, response: "[REI] Invalid format. Use: /saveplan <name>" };
      }

      const planName = saveMatch[1];
      const lastPlanMsg = [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content && isPlanMessage(m.content));

      if (!lastPlanMsg || !lastPlanMsg.content) {
        return {
          success: false,
          response: "[REI] No plan was found in this session to save.",
        };
      }

      try {
        const savedPath = savePlanToFile(workspacePath, planName, lastPlanMsg.content);
        return { success: true, response: `[REI] Full plan saved successfully to: ${savedPath}` };
      } catch (err) {
        return {
          success: false,
          response: `[REI] Error saving plan: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (trimmed.startsWith("/loadplan")) {
      const loadMatch = trimmed.match(/^\/loadplan\s+(\S+)$/i);
      if (!loadMatch) {
        return { success: false, response: "[REI] Invalid format. Use: /loadplan <name>" };
      }

      const planName = loadMatch[1];
      try {
        const planContent = loadPlanFromFile(workspacePath, planName);

        // Ingest the loaded plan as a planning-mode assistant message so /runplan picks it up as
        // the SOURCE (latest planning plan in the session).
        const updatedMessages = [
          ...session.messages,
          {
            role: "assistant" as const,
            content: planContent,
            sourceMode: "planning" as const,
          },
        ];

        saveSession(
          workspacePath,
          updatedMessages,
          session.mode,
          session.summary,
          session.createdAt,
        );

        // Persist it as the cross-session SOURCE fallback too.
        saveCurrentPlanContent(workspacePath, planContent);

        return {
          success: true,
          response: `[REI] Plan '${planName}' loaded into the session. Run it with /runplan or /runplan stage <n>.`,
          newSession: { ...session, messages: updatedMessages },
        };
      } catch (err) {
        return {
          success: false,
          response: `[REI] Error loading plan: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Unreachable: match() guarantees one of the branches above handled it.
    return { success: false, response: "[REI] Unknown plan command." };
  },
};
