import * as readline from "readline";
import type { Agent } from "../core/agent.js";
import type { ChatSession, SessionMode } from "../chat/types.js";

const HELP_TEXT = `Commands:
  /exit           - end the session
  /clear          - clear conversation history
  /help           - show this help
  /mode ask       - switch to ask mode
  /mode planning  - switch to planning mode
  /mode agent     - switch to agent mode`;

export async function runChat(agent: Agent): Promise<void> {
  const session: ChatSession = { messages: [], mode: "ask" };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("rei chat started. Type /help for available commands.");

  const prompt = (): void => {
    rl.question("rei> ", (input) => {
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
          console.log(`Mode set to: ${session.mode}`);
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

      agent.runTurn(session, trimmed).then((response) => {
        console.log(response);
        prompt();
      }).catch((err: unknown) => {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        prompt();
      });
    });
  };

  prompt();

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}
