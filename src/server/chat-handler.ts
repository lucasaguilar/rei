import { Agent } from "../core/agent.js";
import { SessionMode, type ChatSession } from "../chat/types.js";
import { isWorkspaceAllowed } from "../server/workspace-config.js";

export class ChatHandler {
  private agent: Agent;
  private workspacePath: string;

  constructor(agent: Agent, workspacePath: string) {
    this.agent = agent;
    this.workspacePath = workspacePath;
  }

  async handleChatStream(body: any, onChunk: (chunk: string) => void): Promise<string> {
    const messages = body.messages || [];
    const prompt = messages.length > 0 
      ? messages[messages.length - 1].content 
      : "";

    if (!prompt) throw new Error("No prompt provided.");

    // Validar workspace antes de continuar
    if (!isWorkspaceAllowed(this.workspacePath)) {
      throw new Error("Workspace not allowed");
    }

    // 1. Recuperar la sesión actual del workspace para mantener el flow de REI
    const { loadCurrentSession } = await import("../chat/session-store.js");
    const persistedSession = loadCurrentSession(this.workspacePath);
    
    // Asegurar que siempre haya una sesión válida (fallback a sesión nueva)
    const session: ChatSession = persistedSession || {
      messages: [],
      mode: "agent" as SessionMode,
    };

    // 2. Usar streamTurn para obtener la respuesta en tiempo real
    let fullResponse = "";
    const stream = this.agent.streamTurn(session, prompt, {
      onStatus: (status) => onChunk(`\n[STATUS: ${status}]\n`),
    });

    for await (const chunk of stream) {
      fullResponse += chunk;
      onChunk(chunk);
    }

    return fullResponse;
  }
}