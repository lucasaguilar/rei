import { processMenuCommand } from "../../chat/menu-command-processor.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";

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
    agent.provider
  );

  if (result.success) {
    actions.pushTranscript(result.response);
    
    if (result.newSession) {
      Object.assign(session, result.newSession);
    }

    // Handle automatic execution (e.g., /runplan)
    if (result.autoExecute) {
      const { prompt } = result.autoExecute;
      session.messages.push({ role: "user", content: prompt });
      
      state.busy = true;
      actions.draw();
      try {
        const response = await agent.runTurn(session, prompt);
        actions.pushTranscript(response);
      } catch (err) {
        actions.pushTranscript(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        state.busy = false;
        actions.draw();
      }
    }
    return true;
  }

  return false;
}
