import * as readline from "readline";
import type { Agent } from "../core/agent.js";
import type { ChatSession, SessionMode } from "../chat/types.js";

const LOGO = `
██████╗ ███████╗██╗
██╔══██╗██╔════╝██║
██████╔╝█████╗  ██║
██╔══██╗██╔══╝  ██║
██║  ██║███████╗██║
╚═╝  ╚═╝╚══════╝╚═╝
`;

const getWelcomeMessage = (mode: SessionMode): string => `${LOGO}
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
        try {
          for await (const token of agent.streamTurn(session, trimmed)) {
            process.stdout.write(token);
          }
          process.stdout.write("\n");
        } catch (err: unknown) {
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
