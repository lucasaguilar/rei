import * as readline from "readline";
import type { Agent, TurnStatus } from "../core/agent.js";
import type { ChatSession, SessionMode } from "../chat/types.js";
import { REI_LOGO } from "./rei-logo.js";
import { renderMarkdown } from "./markdown-renderer.js";
import { formatPatchForTerminal } from "../tools/patch-generator.js";

const getWelcomeMessage = (mode: SessionMode): string => `${REI_LOGO}
REI — Repository-Aware AI Agent

Mode: ${mode}
Commands:
  /mode ask
  /mode planning
  /mode agent
  /pending
  /confirm
  /confirm --dry-run
  /discard
  /exit

Ready.`;

const HELP_TEXT = `Commands:
  /exit           - end the session
  /clear          - clear conversation history
  /help           - show this help
  /mode ask       - switch to ask mode
  /mode planning  - switch to planning mode
  /mode agent     - switch to agent mode
  /pending        - show currently queued validated patches
  /confirm        - apply queued patches
  /confirm --dry-run - validate/apply-check queued patches only
  /discard        - clear queued patches without applying`;

const MODE_PROMPTS: Record<SessionMode, string> = {
  ask: "ask > ",
  planning: "plan > ",
  agent: "agent > ",
};

const THINKING_TEXT: Record<TurnStatus, string> = {
  building_context: "Building context...",
  calling_model: "Calling model...",
  producing_response: "Producing response...",
};

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

export async function runChat(agent: Agent): Promise<void> {
  const session: ChatSession = { messages: [], mode: "ask" };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let closed = false;
  rl.on("close", () => { closed = true; });

  console.log(getWelcomeMessage(session.mode));

  const prompt = (): void => {
    if (closed) return;
    rl.question(MODE_PROMPTS[session.mode], (input) => {
      const trimmed = input.trim();

      if (trimmed === "/exit") {
        console.log("Goodbye!");
        rl.close();
        return;
      }

      if (trimmed === "/clear") {
        session.messages = [];
        console.log("History cleared.");
        prompt();
        return;
      }

      if (trimmed === "/help") {
        console.log(HELP_TEXT);
        prompt();
        return;
      }

      if (trimmed === "/pending") {
        const pending = agent.getPendingPatches();
        if (pending.length === 0) {
          console.log("No pending patches.");
          prompt();
          return;
        }

        console.log(`Pending patches: ${pending.length}`);
        for (const proposal of pending) {
          console.log(`\nFile: ${proposal.file}`);
          console.log(`Reason: ${proposal.description || "(no description)"}`);
          console.log(formatPatchForTerminal(proposal.patch));
        }
        console.log("\nUse /confirm to apply, or /discard to clear them.");
        prompt();
        return;
      }

      if (trimmed === "/discard") {
        const discarded = agent.clearPendingPatches();
        console.log(discarded > 0 ? `Discarded ${discarded} pending patch(es).` : "No pending patches.");
        prompt();
        return;
      }

      if (trimmed === "/confirm" || trimmed === "/confirm --dry-run") {
        const dryRun = trimmed.includes("--dry-run");
        const pending = agent.getPendingPatches();
        if (pending.length === 0) {
          console.log("No pending patches to apply.");
          prompt();
          return;
        }

        (async () => {
          try {
            const result = await agent.applyPendingPatches({ dryRun });
            if (result.results.length === 0) {
              console.log("No pending patches to apply.");
              prompt();
              return;
            }

            console.log(
              dryRun
                ? "Patch dry-run completed."
                : (result.success ? "Patches applied." : "Patch apply completed with errors.")
            );

            for (const item of result.results) {
              const status = item.applied ? "applied" : (item.skipped ? "skipped" : "failed");
              console.log(`- ${item.file}: ${status}`);
              if (item.validationErrors.length > 0) {
                console.log(`  validation: ${item.validationErrors.join(" | ")}`);
              }
              if (item.stderr) {
                console.log(`  stderr: ${item.stderr.trim()}`);
              }
            }
          } catch (err: unknown) {
            console.error("Error:", err instanceof Error ? err.message : String(err));
          }
          prompt();
        })();
        return;
      }

      const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/);
      if (modeMatch) {
        const requested = modeMatch[1];
        if (requested === "ask" || requested === "planning" || requested === "agent") {
          const previousMode = session.mode;
          session.mode = requested as SessionMode;
          // Soft-reset: when leaving agent mode, drop the non-system history so the
          // new mode's prompt is not polluted by agent JSON from previous turns.
          if (previousMode === "agent" && session.mode !== "agent") {
            const systemMessages = session.messages.filter((m) => m.role === "system");
            session.messages = systemMessages;
          }
          console.log(`[REI] Mode switched to: ${session.mode}`);
        } else {
          console.log(`Unknown mode: ${requested}. Available modes: ask, planning, agent`);
        }
        prompt();
        return;
      }

      if (!trimmed) {
        prompt();
        return;
      }

      (async () => {
        let lastStatus: TurnStatus | undefined;
        let activeStatus: TurnStatus | undefined;
        let spinnerFrame = 0;
        let spinnerWidth = 0;
        let spinnerTimer: NodeJS.Timeout | undefined;

        const renderThinking = (): void => {
          if (!activeStatus) return;
          const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
          spinnerFrame += 1;
          const line = `[REI] Thinking ${frame} ${THINKING_TEXT[activeStatus]}`;
          spinnerWidth = Math.max(spinnerWidth, line.length);
          process.stdout.write(`\r${line.padEnd(spinnerWidth, " ")}`);
        };

        const stopThinking = (): void => {
          if (!spinnerTimer) return;
          clearInterval(spinnerTimer);
          spinnerTimer = undefined;
          process.stdout.write(`\r${" ".repeat(spinnerWidth)}\r`);
        };

        try {
          let buffer = "";
          for await (const token of agent.streamTurn(session, trimmed, {
            onStatus: (status) => {
              if (lastStatus === status) return;
              lastStatus = status;
              activeStatus = status;
              if (!spinnerTimer) {
                renderThinking();
                spinnerTimer = setInterval(renderThinking, 100);
              }
            },
          })) {
            buffer += token;
          }
          stopThinking();
          process.stdout.write("\n" + renderMarkdown(buffer) + "\n\n");
        } catch (err: unknown) {
          stopThinking();
          process.stdout.write("\n");
          console.error("Error:", err instanceof Error ? err.message : String(err));
        }
        prompt();
      })();
    });
  };

  prompt();

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}
