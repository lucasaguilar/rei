import { Agent } from "../core/agent.js";
import { SessionMode, type ChatSession } from "../chat/types.js";
import { isWorkspaceAllowed } from "../server/workspace-config.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import { loadCurrentSession, saveSession } from "../chat/session-store.js";
import { runChat } from "../cli/run-chat.js";
import { buildMentionEntries } from "../cli/helpers/chat.helpers.js";
import { processMenuCommand } from "../chat/menu-command-processor.js";

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

    // Interceptar comandos de menú (ej: /index, /compact, /clear)
    if (promptTrimmed.startsWith("/")) {
      const cmdResult = await processMenuCommand(
        promptTrimmed,
        session,
        this.workspacePath,
        this.agent.provider,
      );

      if (cmdResult.success) {
        // Si el comando actualiza la sesión (ej: /mode o /clear), aplicamos los cambios
        if (cmdResult.newSession) {
          Object.assign(session, cmdResult.newSession);
        }

        // Guardamos la sesión actualizada y devolvemos la respuesta del comando
        if (cmdResult.recordInSession !== false) {
          session.messages.push({ role: "user", content: promptTrimmed });
          session.messages.push({ role: "assistant", content: cmdResult.response });
          saveSession(
            this.workspacePath,
            session.messages,
            session.mode,
            session.summary,
            session.createdAt,
          );
        }

        onChunk(cmdResult.response);
        return cmdResult.response;
      } else {
        onChunk(cmdResult.response);
        return cmdResult.response;
      }
      // Si el comando no fue reconocido o falló, continuamos al flujo del agente
    }

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

    // streamTurn already pushes user + assistant messages to session.messages
    // internally (via prepareSessionForTurn and the various return paths).
    // We only need to persist the session here — do NOT push again.
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
