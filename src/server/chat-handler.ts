import { Agent } from "../core/agent.js";
import { SessionMode, type ChatSession } from "../chat/types.js";
import { isWorkspaceAllowed } from "../server/workspace-config.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import { loadCurrentSession, saveSession } from "../chat/session-store.js";
import { runChat } from "../cli/run-chat.js";
import { buildMentionEntries } from "../cli/helpers/chat.helpers.js";

export class ChatHandler {
  constructor(
    private agent: Agent,
    private workspacePath: string,
  ) {}

  async handleChatStream(
    body: any,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    const messages = body.messages || [];
    const prompt =
      messages.length > 0 ? messages[messages.length - 1].content : "";
    const promptTrimmed = prompt.trim();

    if (!promptTrimmed) throw new Error("No prompt provided.");

    // Validar workspace antes de continuar
    if (!isWorkspaceAllowed(this.workspacePath)) {
      throw new Error("Workspace not allowed");
    }

    // 1. Recuperar la sesión actual del workspace para mantener el flow de REI
    const existing = loadCurrentSession(this.workspacePath);
    const session: ChatSession = existing
      ? {
          messages: existing.messages,
          mode: existing.mode,
          createdAt: existing.createdAt,
          summary: existing.summary,
        }
      : { messages: [], mode: "agent" };
    //const mentionEntries = buildMentionEntries(this.workspacePath);

    //await InputHandler.submitInput(inputContext);

    //const { state, actions, session, agent, workspacePath } = ctx;

    // Delegamos la construcción del contexto y el mensaje de sistema al Agent.
    // El Agent internamente utiliza buildTurnContext y buildSystemMessage (prompt-builder.ts)
    // para asegurar que la lógica de negocio sea consistente en CLI y Server.
    let fullResponse = "";
    const stream = this.agent.streamTurn(session, promptTrimmed, {
      onStatus: (status) => {
        console.log(`[Agent Status]: ${status}`);
      },
    });

    for await (const chunk of stream) {
      fullResponse += chunk;
      onChunk(chunk);
    }

    // Guardar la sesión actualizada después del turno (igual que en terminal)
    // Agregar el mensaje del usuario y del asistente a la sesión
    session.messages.push({ role: "user", content: promptTrimmed });
    session.messages.push({ role: "assistant", content: fullResponse });
    saveSession(
      this.workspacePath,
      session.messages,
      session.mode,
      session.summary,
      session.createdAt,
    );

    return fullResponse;
  }
}
