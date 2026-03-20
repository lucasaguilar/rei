import * as path from "path";
import type { ModelProvider } from "../providers/model-provider.js";
import type { ChatSession } from "../chat/types.js";
import { buildSystemMessage } from "../prompts/prompt-builder.js";
import { buildTurnContext, type TurnContext } from "../context/context-builder.js";
import { buildMessagesForModel } from "../chat/message-builder.js";

export class Agent {
  constructor(
    private readonly provider: ModelProvider,
    private readonly workspacePath: string = process.cwd()
  ) {}

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
  }

  async runTurn(session: ChatSession, userInput: string): Promise<string> {
    const systemContent = buildSystemMessage(session.mode);

    // Keep the system message at position 0 reflecting the current mode.
    if (session.messages.length > 0 && session.messages[0].role === "system") {
      session.messages[0] = { role: "system", content: systemContent };
    } else {
      session.messages.unshift({ role: "system", content: systemContent });
    }

    const context = await buildTurnContext({
      workspacePath: this.workspacePath,
      userInput,
      mode: session.mode,
    });

    debugContext(context);

    const enrichedMessage = buildTurnUserMessage({ userInput, context });

    session.messages.push({ role: "user", content: enrichedMessage });

    // session.messages holds the complete history; send only a trimmed
    // window to the provider to keep prompt size under control.
    const messagesForModel = buildMessagesForModel(session.messages);
    const response = await this.provider.completeChat(messagesForModel);
    session.messages.push({ role: "assistant", content: response });
    return response;
  }
}

export function buildTurnUserMessage(params: {
  userInput: string;
  context: TurnContext;
}): string {
  const { userInput, context } = params;
  const lines: string[] = [];

  lines.push(`Task: ${userInput}`);
  lines.push(``);
  lines.push(`Workspace: ${context.workspacePath}`);
  lines.push(``);
  lines.push(`Repository summary:`);
  lines.push(context.repoSummary);

  if (context.relevantFiles.length > 0) {
    lines.push(``);
    lines.push(`Relevant files:`);
    for (const file of context.relevantFiles) {
      lines.push(``);
      lines.push(`--- ${file.path} (score: ${file.score}) ---`);
      lines.push(file.preview);
    }
  }

  return lines.join("\n");
}

function debugContext(context: TurnContext): void {
  const scannedNote = `[REI debug] Workspace: ${path.resolve(context.workspacePath)}`;
  const filesNote = `[REI debug] Relevant files selected: ${context.relevantFiles.length}`;
  const fileList = context.relevantFiles
    .map((f) => `  - ${f.path} (score: ${f.score})`)
    .join("\n");

  console.log(scannedNote);
  console.log(filesNote);
  if (fileList) console.log(fileList);
}
