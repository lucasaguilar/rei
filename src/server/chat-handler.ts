import { Agent } from "../core/agent.js";
import { createModelProvider } from "../providers/provider-factory.js";
import { SessionMode, type ChatSession } from "../chat/types.js";
import { isWorkspaceAllowed } from "../server/workspace-config.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import { loadCurrentSession, saveSession } from "../chat/session-store.js";
import { runChat } from "../cli/run-chat.js";
import { buildMentionEntries } from "../cli/helpers/chat.helpers.js";
import { processMenuCommand } from "../chat/menu-command-processor.js";

/**
 * REI yields per-edit diffs in terminal format: `Archivo: <file>` followed by
 * lines prefixed with `+`/`-`/space. Markdown renderers (e.g. Continue) read `-`
 * as a bullet and indented lines as separate code blocks, fragmenting the diff.
 * This rewrites such a chunk into a single fenced ```diff block.
 */
function wrapDiffForMarkdown(text: string): string {
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const body = text.slice(lead.length);
  if (!body.startsWith("Archivo:")) return text;

  const nl = body.indexOf("\n");
  if (nl === -1) return text;
  const file = body.slice("Archivo:".length, nl).trim();
  const diff = body.slice(nl + 1).replace(/\s+$/, "");
  return `${lead}**Archivo:** ${file}\n\`\`\`diff\n${diff}\n\`\`\`\n`;
}

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
      throw new Error(`Workspace not allowed, ${this.workspacePath}`);
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

    // Accumulates everything emitted to the client this request. The helper below
    // applies the same prefix/ANSI cleanup, de-dup and leading-trim used for the
    // main agent stream, so commands that auto-execute (e.g. /runplan) render the
    // same way as a normal turn.
    let fullResponse = "";
    const consumeStream = async (
      stream: AsyncIterable<string>,
    ): Promise<void> => {
      for await (const chunk of stream) {
        // \x10 = thinking (discard from API output), \x11 = response text,
        // raw = status/ANSI strings.
        if (chunk.startsWith("\x10")) {
          fullResponse += chunk.slice(1);
          continue;
        }
        let clean = chunk.startsWith("\x11")
          ? chunk.slice(1)
          : chunk.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[^m]*m/g, "");
        if (!clean) continue;
        // Patch diffs are emitted in terminal format ("Archivo: …" + +/-/space
        // prefixed lines). Markdown clients (Continue) turn those into bullets and
        // fragmented code blocks, so wrap them in a ```diff fence to render as one block.
        clean = wrapDiffForMarkdown(clean);
        // De-dup: streaming clients accumulate deltas — skip large chunks already sent.
        if (clean.length > 40 && fullResponse.includes(clean.trim())) continue;
        // Trim leading whitespace only at the very start of the response.
        const out = fullResponse.length === 0 ? clean.replace(/^\s+/, "") : clean;
        if (!out) continue;
        fullResponse += out;
        onChunk(out);
      }
    };

    // Interceptar comandos de menú (ej: /index, /compact, /clear, /runplan)
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

        // Commands like /model and /provider change env vars and ask to rebuild the
        // agent so the new model/provider + MCP tools take effect. Mirror the CLI:
        // dispose the old MCP connections, build a fresh agent, reconnect MCP. Done
        // BEFORE any autoExecute so it runs on the new agent.
        if (cmdResult.recreateAgent) {
          try {
            await this.agent.disposeMcp();
          } catch {
            // best-effort teardown
          }
          this.agent = new Agent(createModelProvider(), this.workspacePath);
          try {
            await this.agent.connectMcp();
          } catch (error) {
            console.error(
              `⚠️  MCP reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (cmdResult.recordInSession !== false) {
          session.messages.push({ role: "user", content: promptTrimmed });
          session.messages.push({
            role: "assistant",
            content: cmdResult.response,
          });
        }

        onChunk(cmdResult.response);
        fullResponse += cmdResult.response;

        // Commands like /runplan return an autoExecute prompt that must actually run
        // the agent turn — the CLI does this; the server must too, otherwise the
        // command only prints "Switching to AGENT mode…" and nothing executes.
        if (cmdResult.autoExecute) {
          await consumeStream(
            this.agent.streamTurn(session, cmdResult.autoExecute.prompt, {
              onStatus: () => {},
            }),
          );
        }

        saveSession(
          this.workspacePath,
          session.messages,
          session.mode,
          session.summary,
          session.createdAt,
        );
        return fullResponse;
      } else {
        onChunk(cmdResult.response);
        return cmdResult.response;
      }
      // Si el comando no fue reconocido o falló, continuamos al flujo del agente
    }

    // Delegamos la construcción del contexto y el mensaje de sistema al Agent.
    // El Agent internamente utiliza buildTurnContext y buildSystemMessage (prompt-builder.ts)
    // para asegurar que la lógica de negocio sea consistente en CLI y Server.
    await consumeStream(
      this.agent.streamTurn(session, promptTrimmed, { onStatus: () => {} }),
    );

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
