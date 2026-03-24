import * as readline from "readline";
import type { Agent, TurnStatus } from "../core/agent.js";
import type { ChatSession, SessionMode } from "../chat/types.js";
import { REI_LOGO } from "./rei-logo.js";

const getWelcomeMessage = (mode: SessionMode): string => `${REI_LOGO}
REI — Repository-Aware AI Agent

Mode: ${mode}
Commands:
  /mode ask
  /mode planning
  /mode agent
  /exit

Ready.`;

const HELP_TEXT = `Commands:
  /exit           - end the session
  /clear          - clear conversation history
  /help           - show this help
  /mode ask       - switch to ask mode
  /mode planning  - switch to planning mode
  /mode agent     - switch to agent mode`;

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

      const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/);
      if (modeMatch) {
        const requested = modeMatch[1];
        if (requested === "ask" || requested === "planning" || requested === "agent") {
          session.mode = requested as SessionMode;
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
            stopThinking();
            process.stdout.write(token);
          }
          stopThinking();
          process.stdout.write("\n");
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
