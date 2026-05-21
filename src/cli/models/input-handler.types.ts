import type { Agent } from "../../core/agent.js";
import type { ChatSession } from "../../chat/types.js";
import type { ActivePalette, ChatUIState } from "./chat.types.js";

export interface InputHandlerContext {
  state: ChatUIState;
  agent: Agent;
  session: ChatSession;
  transcript: string[];
  workspacePath: string;
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
