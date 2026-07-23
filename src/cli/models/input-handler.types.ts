import type { Agent } from "../../core/agent.js";
import type { ChatSession } from "../../chat/types.js";
import type { ActivePalette, ChatUIState } from "./chat.types.js";
import type { ElicitFn } from "../../chat/elicitation.js";

export interface InputHandlerContext {
  state: ChatUIState;
  agent: Agent;
  session: ChatSession;
  transcript: string[];
  workspacePath: string;
  /** Transcript-based elicitation for the ask_user tool (CLI). Forwarded to the agent turn so the
   *  model can ask the user a question mid-turn. See docs/intent-router-spec.md. */
  elicit?: ElicitFn;
  actions: {
    pushTranscript(value: string, writeToStdout?: boolean): void;
    streamText(value: string): void;
    draw(): void;
    startSpinner(): void;
    stopSpinner(): void;
    resetInput(): void;
    rememberHistory(value: string): void;
    getActivePalette(): ActivePalette;
    getMentionContext():
      | { start: number; end: number; query: string }
      | undefined;
  };
}
