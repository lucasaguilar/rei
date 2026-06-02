import { processMenuCommand } from "../../chat/menu-command-processor.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import { createModelProvider } from "../../providers/provider-factory.js";
import { Agent } from "../../core/agent.js";
import { handleInputTurn } from "./input-turn.helpers.js";

export async function handleInputCommand(
  trimmed: string,
  ctx: InputHandlerContext,
): Promise<boolean> {
  const { state, agent, session, actions } = ctx;

  if (trimmed === "/exit") {
    actions.pushTranscript("Goodbye!");
    actions.draw();
    state.running = false;
    return true;
  }

  // Delegate to the centralized command processor
  const result = await processMenuCommand(
    trimmed,
    session,
    ctx.workspacePath,
    agent.provider,
  );

  if (result.success) {
    actions.pushTranscript(result.response);

    if (result.recreateAgent) {
      // Tear down the old agent's MCP connections before swapping in a new one,
      // then reconnect so the fresh agent has the same tools available.
      await ctx.agent.disposeMcp();
      const newProvider = createModelProvider();
      ctx.agent = new Agent(newProvider, ctx.workspacePath);
      try {
        await ctx.agent.connectMcp();
      } catch (error) {
        console.error(
          `⚠️  MCP reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (result.newSession) {
      Object.assign(session, result.newSession);
    }

    // Handle automatic execution (e.g., /runplan) via the full streaming pipeline
    // so patch diffs and live output are shown correctly.
    if (result.autoExecute) {
      const { prompt } = result.autoExecute;
      const stageMatch = prompt.match(/\[RUNPLAN STAGE (\d+)\]/i);
      const displayText = stageMatch
        ? `[RUNPLAN STAGE ${stageMatch[1]}]`
        : "[RUNPLAN]";
      await handleInputTurn(prompt, ctx, { displayText });
    }
    return true;
  }

  // Any slash-prefixed input is treated as a command. If it fails,
  // surface the command error and do not fall through to model execution.
  if (trimmed.startsWith("/")) {
    actions.pushTranscript(result.response);
    return true;
  }

  return false;
}
