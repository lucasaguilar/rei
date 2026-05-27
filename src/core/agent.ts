import type { ModelProvider } from "../providers/model-provider.js";
import {
  resolveModelForMode,
  createProviderForMode,
} from "../providers/provider-factory.js";
import {
  executeAgentTurn,
  executeAgentTurnWholefile,
} from "../agent-mode/generator.js";
import {
  buildSystemMessage,
  getAgentEditFormat,
} from "../prompts/prompt-builder.js";
import { buildTurnContext } from "../context/context-builder.js";
import { buildMessagesForModel } from "../chat/message-builder.js";
import { compactSession, needsCompaction } from "../chat/compactor.js";
import { type ChatSession } from "../chat/types.js";
import {
  readPlanTodoFile,
  markStageAsCompleted,
} from "../chat/plan-tracker.js";
import {
  generateRepoMap,
  generateRepoMapForFile,
} from "../tools/repo-map-generator.js";
import { VectorStore } from "../context/rag/vector-store.js";
import { generateEmbedding } from "../context/rag/embedder.js";
import {
  chunkRepoMap,
  chunkRepoMapString,
} from "../context/rag/map-chunker.js";
import { getRelevantMapContext } from "../context/rag/map-retriever.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import {
  scanWorkspace,
  type FileMeta,
} from "../workspace/workspace-scanner.js";
import {
  applySREditBatchFS,
  type BatchPatchApplyResult,
} from "../tools/patch-applier.js";
import {
  executeCommand,
  limitCommandOutput,
} from "../tools/command-executor.js";
import {
  extractCommandRequests,
  extractToolCalls,
  extractFileRequests,
} from "../agent-mode/response-handler.js";
import {
  getWeather,
  formatWeatherOutput,
  type WeatherResult,
} from "../tools/weather-tool.js";
import { searchWeb } from "../tools/search-tool.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { KnowledgeOrchestrator } from "../knowledge/orchestrator.js";
import { AgentLogger } from "./logger.js";
import { SCAN_CACHE_TTL_MS } from "./constants/agent.constants.js";
import {
  buildTurnUserMessage,
  looksLikeAgentJson,
} from "./helpers/turn-message.helpers.js";
import type {
  StreamTurnOptions,
  PendingPatchAssessmentItem,
  PendingPatchAssessment,
} from "./models/agent.types.js";

function extractStageNumberFromPrompt(prompt: string): number | null {
  const match = prompt.match(/\[RUNPLAN STAGE (\d+)\]/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

export class Agent {
  private scanCache?: {
    workspacePath: string;
    files: FileMeta[];
    timestamp: number;
  };
  private knowledgeOrchestrator: KnowledgeOrchestrator;
  private vectorStore: VectorStore;
  private repoMapCache?: string;
  private watcher?: FSWatcher;
  public logger: AgentLogger;
  public readonly provider: ModelProvider;
  private readonly workspacePath: string;
  private correlationId: string;

  constructor(provider: ModelProvider, workspacePath: string = process.cwd()) {
    this.provider = provider;
    this.workspacePath = workspacePath;
    this.knowledgeOrchestrator = new KnowledgeOrchestrator(this.provider);
    this.logger = new AgentLogger(workspacePath);
    this.vectorStore = new VectorStore(workspacePath);
    this.correlationId =
      Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
  }

  async assessPendingPatchesSafety(): Promise<PendingPatchAssessment> {
    // No hay más pending patches; solo retorna vacío para compatibilidad.
    return {
      workspaceQualityOk: true,
      workspaceQualityStderr: "",
      items: [],
    };
  }

  async runTurn(session: ChatSession, userInput: string): Promise<string> {
    this.logger.startTurn();
    this.logger.setCorrelationId(this.correlationId);
    const enrichedUserMessage = await this.prepareSessionForTurn(
      session,
      userInput,
    );
    await this.compactSessionIfNeeded(session);

    // session.messages holds the complete history; send only a trimmed
    // window to the provider to keep prompt size under control.
    const baseMessagesForModel = buildMessagesForModel(
      session.messages,
      session.mode,
      session.mode === "agent" ? getAgentEditFormat() : undefined,
    );
    const messagesForModel = this.injectCurrentTurnContext(
      baseMessagesForModel,
      enrichedUserMessage,
    );
    const response = await this.generateAssistantResponse(
      session.mode,
      messagesForModel,
    );
    session.messages.push({
      role: "assistant",
      content: response,
      sourceMode: session.mode,
    });

    if (session.mode === "agent") {
      const stageNum = extractStageNumberFromPrompt(userInput);
      if (stageNum !== null) {
        const wasSuccessful = response.includes("patch(es) applied directly.") || response.includes("file(s) written.");
        if (wasSuccessful) {
          markStageAsCompleted(this.workspacePath, stageNum);
        }
      }
    }

    return response;
  }

  async *streamTurn(
    session: ChatSession,
    userInput: string,
    options?: StreamTurnOptions,
  ): AsyncIterable<string> {
    this.logger.startTurn();
    this.logger.setCorrelationId(this.correlationId);
    const enrichedUserMessage = await this.prepareSessionForTurn(
      session,
      userInput,
      options?.onStatus,
    );
    await this.compactSessionIfNeeded(session, options?.onStatus);

    const baseMessagesForModel = buildMessagesForModel(
      session.messages,
      session.mode,
      session.mode === "agent" ? getAgentEditFormat() : undefined,
    );
    const messagesForModel = this.injectCurrentTurnContext(
      baseMessagesForModel,
      enrichedUserMessage,
    );
    options?.onStatus?.("calling_model");

    if (session.mode === "agent") {
      const editFormat = getAgentEditFormat();
      const agentProvider = createProviderForMode("agent", this.provider);
      const outcome =
        editFormat === "wholefile"
          ? await executeAgentTurnWholefile({
              provider: agentProvider,
              messagesForModel,
              workspacePath: this.workspacePath,
              logger: this.logger,
              modelOverride: resolveModelForMode("agent"),
            })
          : await executeAgentTurn({
              provider: agentProvider,
              messagesForModel,
              workspacePath: this.workspacePath,
              scannedFiles: this.getWorkspaceFiles(),
              logger: this.logger,
              modelOverride: resolveModelForMode("agent"),
            });

      // Si hay parches válidos, aplicarlos directamente
      if (
        outcome.validProposedPatches &&
        outcome.validProposedPatches.length > 0
      ) {
        const result = await applySREditBatchFS(
          outcome.validProposedPatches,
          this.workspacePath,
        );
        const msg = result.success
          ? `\n\n---\n[32m[1m${result.results.length} patch(es) applied directly.\u001b[0m` +
            result.results
              .map(
                (r) =>
                  `\n- ${r.file}: ${r.applied ? "applied" : r.skipped ? "skipped" : "failed"}`,
              )
              .join("")
          : `\n\n---\n[31m[1mSome patches failed to apply.\u001b[0m` +
            result.results
              .map(
                (r) =>
                  `\n- ${r.file}: ${r.applied ? "applied" : r.skipped ? "skipped" : "failed"}`,
              )
              .join("");
        const fullResponse = outcome.response + msg;
        session.messages.push({ role: "assistant", content: outcome.response });
        options?.onStatus?.("producing_response");
        yield fullResponse;

        if (result.success) {
          const stageNum = extractStageNumberFromPrompt(userInput);
          if (stageNum !== null) {
            markStageAsCompleted(this.workspacePath, stageNum);
          }
        }

        return;
      }

      // Interceptación de herramientas y comandos antes de finalizar el turno
      const toolCalls = extractToolCalls(outcome.response);
      const commands = extractCommandRequests(outcome.response);

      if (toolCalls.length > 0 || commands.length > 0) {
        let feedback = "\n\n--- Execution Results ---\n";

        // 1. Procesar Tool Calls
        for (const call of toolCalls) {
          this.logger.logInfo(`Calling tool: ${call.name}`, {
            args: call.args,
          });
          try {
            if (call.name === "weather") {
              const weatherRes = await getWeather(call.args.location as string);
              feedback += `\n### 🌤️ Weather: ${call.args.location}\n${formatWeatherOutput(weatherRes)}\n`;
            } else if (call.name === "search") {
              const searchRes = await searchWeb(
                call.args.query as string,
                this.provider,
              );
              feedback += `\n### 🔍 Search Results: ${call.args.query}\n${searchRes}\n`;
            } else {
              throw new Error(`Tool "${call.name}" is not implemented.`);
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            feedback += `\n[TOOL] ${call.name}(${JSON.stringify(call.args)}) -> ERROR: ${errorMsg}\n`;
          }
        }

        // 2. Procesar Commands (si existen)
        for (const cmd of commands) {
          this.logger.logInfo(`Executing command: ${cmd}`);
          const result = await executeCommand(cmd, this.workspacePath);
          this.logger.logCommandExecution(cmd, result);
          feedback += `\n[COMMAND] ${cmd} (Exit: ${result.exitCode})\nStdout: ${result.stdout || "none"}\nStderr: ${result.stderr || "none"}\n`;
        }

        // Mostrar feedback al usuario final, no solo al modelo
        const userVisibleResponse = outcome.response + feedback;
        session.messages.push({
          role: "assistant",
          content: userVisibleResponse,
        });
        options?.onStatus?.("producing_response");
        yield userVisibleResponse;
        return;
      }

      // Si no hay parches ni comandos, solo responde
      session.messages.push({ role: "assistant", content: outcome.response });
      options?.onStatus?.("producing_response");
      yield outcome.response;

      if (editFormat === "wholefile" && !outcome.failed) {
        const stageNum = extractStageNumberFromPrompt(userInput);
        if (stageNum !== null) {
          markStageAsCompleted(this.workspacePath, stageNum);
        }
      }

      return;
    }

    if (this.provider.streamChat) {
      let currentMessages = [...messagesForModel];
      let hasMoreCommands = true;
      let depth = 0;
      const maxDepth = process.env.REI_MAX_TURNS ? parseInt(process.env.REI_MAX_TURNS, 10) : 7;

      while (hasMoreCommands && depth < maxDepth) {
        let streamResponse = "";
        options?.onStatus?.("producing_response");

        // Collect tokens into a buffer first so we can inspect the full
        // response before deciding what to yield. This prevents partial
        // <call_tool> / <execute_command> XML from being printed to the
        // terminal before the tool-call detection logic runs.
        const tokenBuffer: string[] = [];
        for await (const token of this.provider.streamChat(currentMessages, {
          model: resolveModelForMode(session.mode),
        })) {
          streamResponse += token;
          tokenBuffer.push(token);
        }

        const commands = extractCommandRequests(streamResponse);
        const toolCalls = extractToolCalls(streamResponse);
        const fileRequests = extractFileRequests(streamResponse);

        if (commands.length > 0 || toolCalls.length > 0 || fileRequests.length > 0) {
          // Yield the visible part of the response (strip XML tags) before
          // the tool-result block so the user sees the prose intro, if any.
          const visibleResponse = streamResponse
            .replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, "")
            .replace(/<call_tool\s+name="[^"]+">[\s\S]*?<\/call_tool>/gi, "")
            .replace(/<request_files>[\s\S]*?<\/request_files>/gi, "")
            .trim();
          if (visibleResponse) {
            yield visibleResponse + "\n";
          }

          depth++;
          let executionFeedback = "";
          let userVisibleFeedback = "";

          if (fileRequests.length > 0) {
            const fileFeedback = await this.executeFileRequestsFromResponse(streamResponse);
            executionFeedback += fileFeedback;
            userVisibleFeedback += `\n📂 **[REI] Injected ${fileRequests.length} requested file(s) into context:**\n` +
              fileRequests.map((f) => `- \`${f}\``).join("\n") + "\n";
          }
          if (commands.length > 0) {
            const cmdFeedback = await this.executeCommandsFromResponse(streamResponse);
            executionFeedback += cmdFeedback;
            userVisibleFeedback += cmdFeedback;
          }
          if (toolCalls.length > 0) {
            const toolFeedback = await this.executeToolCallsFromResponse(streamResponse);
            executionFeedback += toolFeedback;
            userVisibleFeedback += toolFeedback;
          }

          yield userVisibleFeedback;
          currentMessages = [
            ...currentMessages,
            { role: "assistant", content: streamResponse },
            {
              role: "user",
              content: `System: Execution results:\n${executionFeedback}\n\nNow continue your process or provide your complete answer using these results.`,
            },
          ];
        } else {
          hasMoreCommands = false;

          // No tool calls — stream was buffered, so replay tokens now for
          // real-time output on the terminal.
          for (const token of tokenBuffer) {
            yield token;
          }

          // Concat all assistant chunks for session storage
          const allAssistantChunks = currentMessages
            .slice(messagesForModel.length)
            .filter((m) => m.role === "assistant")
            .map((m) => m.content);

          allAssistantChunks.push(streamResponse);

          const finalContent = allAssistantChunks.join("\n\n");
          const cleanAssistantContent = finalContent
            .replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, "")
            .replace(/<call_tool\s+name="[^"]+">[\s\S]*?<\/call_tool>/gi, "")
            .replace(/<request_files>[\s\S]*?<\/request_files>/gi, "")
            .trim();

          session.messages.push({
            role: "assistant",
            content: cleanAssistantContent,
            sourceMode: session.mode,
          });
        }
      }
    } else {
      const response = await this.generateNonAgentAssistantResponse(
        session.mode,
        messagesForModel,
      );
      session.messages.push({
        role: "assistant",
        content: response,
        sourceMode: session.mode,
      });
      options?.onStatus?.("producing_response");
      yield response;
    }
  }

  private getWorkspaceFiles(): FileMeta[] {
    const now = Date.now();
    if (
      this.scanCache &&
      this.scanCache.workspacePath === this.workspacePath &&
      now - this.scanCache.timestamp < SCAN_CACHE_TTL_MS
    ) {
      return this.scanCache.files;
    }

    const files = scanWorkspace(this.workspacePath);
    this.scanCache = {
      workspacePath: this.workspacePath,
      files,
      timestamp: now,
    };
    return files;
  }

  private async generateAssistantResponse(
    mode: ChatSession["mode"],
    messagesForModel: ChatSession["messages"],
  ): Promise<string> {
    if (mode !== "agent") {
      return this.generateNonAgentAssistantResponse(mode, messagesForModel);
    }

    return this.generateAgentAssistantResponse(messagesForModel);
  }

  private async updateSystemContextWithRepoMap(
    session: ChatSession,
    userInput?: string,
  ): Promise<string | undefined> {
    let repositorySkeletonMap: string | undefined = undefined;

    // 1. Asegurar que el mapa esté generado e indexado en el VectorStore
    if (!this.repoMapCache) {
      this.repoMapCache = await generateRepoMap(this.workspacePath);

      await this.vectorStore.load();

      // Limpiar registros fantasma (archivos borrados mientras REI estaba apagado)
      const currentFiles = scanWorkspace(this.workspacePath);
      const activePaths = new Set(currentFiles.map((f) => f.path));
      await this.vectorStore.cleanupStaleFiles(activePaths);

      const chunks = await chunkRepoMap(this.workspacePath);
      const chunksToEmbed = chunks.filter(chunk => {
        const hash = crypto
          .createHash("md5")
          .update(chunk.content)
          .digest("hex");
        const existing = this.vectorStore.getById(chunk.metadata.id);
        return !existing || existing.metadata.fileHash !== hash;
      });

      if (chunksToEmbed.length > 0) {
        console.log(
          `\n\x1b[33m[REI] Indexando repositorio: Generando embeddings locales para ${chunksToEmbed.length} bloque(s) de código...` +
          `\n      Esto se procesa en tu CPU y puede tomar de 30 a 90 segundos en el primer arranque. Por favor espera...\x1b[0m\n`
        );
      }

      for (const chunk of chunks) {
        const hash = crypto
          .createHash("md5")
          .update(chunk.content)
          .digest("hex");
        const existing = this.vectorStore.getById(chunk.metadata.id);

        if (existing && existing.metadata.fileHash === hash) {
          continue; // Saltar cálculo pesado, el contenido no cambió
        }

        const vector = await generateEmbedding(chunk.content);
        this.vectorStore.upsert(
          {
            ...chunk.metadata,
            content: chunk.content,
            fileHash: hash,
          },
          vector,
        );
      }
      await this.vectorStore.save();
      this.initWatcher();
    }

    // 2. Recuperar solo fragmentos relevantes basados en la entrada del usuario
    if (userInput) {
      const relevantMap = await getRelevantMapContext(
        this.vectorStore,
        userInput,
      );
      repositorySkeletonMap = relevantMap
        ? `### RELEVANT REPOSITORY SKELETON MAP\n\n${relevantMap}`
        : undefined;
    } else {
      repositorySkeletonMap = undefined;
    }

    // Rebuild system message on every turn or when mode changes, to keep the active plan progress checklist in sync.
    const baseSystemContent = buildSystemMessage(
      session.mode,
      this.workspacePath,
    );
    let systemContent = baseSystemContent;
    const todoContent = readPlanTodoFile(this.workspacePath);
    if (todoContent) {
      systemContent += `\n\n### Active Plan Progress:\n${todoContent}`;
    }

    if (
      session.messages.length > 0 &&
      session.messages[0].role === "system"
    ) {
      session.messages[0].content = systemContent;
    } else {
      session.messages.unshift({ role: "system", content: systemContent });
    }

    return repositorySkeletonMap;
  }

  private async prepareSessionForTurn(
    session: ChatSession,
    userInput: string,
    onStatus?: StreamTurnOptions["onStatus"],
  ): Promise<string> {
    onStatus?.("building_context");
    const repositorySkeletonMap = await this.updateSystemContextWithRepoMap(
      session,
      userInput,
    );
    this.logger.logUserPrompt({
      mode: session.mode,
      prompt: userInput,
    });

    const context = await buildTurnContext({
      workspacePath: this.workspacePath,
      scannedFiles: this.getWorkspaceFiles(),
      userInput,
      mode: session.mode,
      knowledgeOrchestrator: this.knowledgeOrchestrator,
      onStatus,
    });

    if (context.ragResults && context.ragResults.length > 0) {
      this.logger.logContextSearch(
        userInput,
        context.ragResults.map((r) => ({
          filePath: r.metadata.filePath,
          nodeType: r.metadata.nodeType,
          nodeName: r.metadata.nodeName,
          score: r.score,
        })),
      );
    }

    const enrichedMessage = buildTurnUserMessage({
      userInput,
      context,
      repositorySkeletonMap,
    });

    this.logger.logInfo("Enriched user message size", {
      chars: enrichedMessage.length,
      estimatedTokens: Math.round(enrichedMessage.length / 4),
    });

    // Persist only the raw user input so historical turns stay compact.
    session.messages.push({ role: "user", content: userInput });

    return enrichedMessage;
  }

  private injectCurrentTurnContext(
    messagesForModel: ChatSession["messages"],
    enrichedUserMessage: string,
  ): ChatSession["messages"] {
    const patched = [...messagesForModel];
    for (let index = patched.length - 1; index >= 0; index -= 1) {
      if (patched[index].role === "user") {
        patched[index] = {
          ...patched[index],
          content: enrichedUserMessage,
        };
        return patched;
      }
    }
    return patched;
  }

  private async compactSessionIfNeeded(
    session: ChatSession,
    onStatus?: StreamTurnOptions["onStatus"],
  ): Promise<void> {
    if (!needsCompaction(session.messages)) {
      return;
    }

    onStatus?.("compacting_memory");
    session.messages = await compactSession({
      messages: session.messages,
      provider: this.provider,
      modelOverride: process.env.COMPACTOR_MODEL,
    });
  }

  /** Reads the contents of any <request_files> tags found in a response and returns formatted feedback. */
  private async executeFileRequestsFromResponse(response: string): Promise<string> {
    const fileRequests = extractFileRequests(response);
    if (fileRequests.length === 0) return "";

    let feedback = "\n\n---\n**Requested Files Context:**\n";
    for (const f of fileRequests) {
      this.logger.logInfo(`Non-agent requested file: ${f}`);
      const absPath = path.join(this.workspacePath, f);
      try {
        const content = await fs.readFile(absPath, "utf-8");
        feedback += `\n### File: ${f}\n\`\`\`\n${content}\n\`\`\`\n`;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        feedback += `\n### File: ${f}\n(Could not read file: ${errorMsg})\n`;
      }
    }
    return feedback;
  }

  /** Executes any <execute_command> tags found in a response and returns formatted feedback. */
  private async executeCommandsFromResponse(response: string): Promise<string> {
    const commands = extractCommandRequests(response);
    if (commands.length === 0) return "";

    let feedback = "\n\n---\n**Command Results:**\n```\n";
    for (const cmd of commands) {
      this.logger.logInfo(`Executing command: ${cmd}`);
      const result = await executeCommand(cmd, this.workspacePath);
      this.logger.logCommandExecution(cmd, result);
      const output = limitCommandOutput(
        [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
      );
      feedback += `$ ${cmd}\n${output || "(no output)"} [exit: ${result.exitCode}]\n\n`;
    }
    feedback += "```";
    return feedback;
  }

  /** Executes any <call_tool> tags found in a response and returns formatted feedback. */
  private async executeToolCallsFromResponse(
    response: string,
  ): Promise<string> {
    const toolCalls = extractToolCalls(response);
    if (toolCalls.length === 0) return "";

    let feedback = "\n\n---\n**Tool Call Results:**\n";
    for (const call of toolCalls) {
      this.logger.logInfo(`Calling tool: ${call.name}`, { args: call.args });
      try {
        if (call.name === "weather") {
          const weatherRes = await getWeather(call.args.location as string);
          feedback += `\n### 🌤️ Weather: ${call.args.location}\n${formatWeatherOutput(weatherRes)}\n`;
        } else if (call.name === "search") {
          const searchRes = await searchWeb(
            call.args.query as string,
            this.provider,
          );
          feedback += `\n### 🔍 Search Results: ${call.args.query}\n${searchRes}\n`;
        } else {
          throw new Error(`Tool "${call.name}" is not implemented.`);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        feedback += `\n[TOOL] ${call.name}(${JSON.stringify(call.args)}) -> ERROR: ${errorMsg}\n`;
      }
    }
    return feedback;
  }

  private async generateNonAgentAssistantResponse(
    mode: ChatSession["mode"],
    messagesForModel: ChatSession["messages"],
  ): Promise<string> {
    let currentMessages = [...messagesForModel];
    let hasMoreCommands = true;
    let depth = 0;
    const maxDepth = process.env.REI_MAX_TURNS ? parseInt(process.env.REI_MAX_TURNS, 10) : 7;
    let lastResponse = "";

    while (hasMoreCommands && depth < maxDepth) {
      const raw = await this.provider.completeChat(currentMessages, {
        model: resolveModelForMode(mode),
      });

      if (looksLikeAgentJson(raw) && depth === 0) {
        const retryMessages: ChatSession["messages"] = [
          ...currentMessages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content:
              `You are in ${mode} mode. Your previous response was a JSON object. ` +
              "That is not valid for this mode. " +
              "Return a plain text answer only. Do not output JSON. Do not use markdown code blocks.",
          },
        ];
        const retried = await this.provider.completeChat(retryMessages, {
          model: resolveModelForMode(mode),
        });
        if (looksLikeAgentJson(retried)) {
          return `I'm in ${mode} mode and my response came out as structured JSON, which is not valid here. Please rephrase your question or switch to agent mode if you need structured output.`;
        }
        lastResponse = retried;
      } else {
        lastResponse = raw;
      }

      currentMessages.push({ role: "assistant", content: lastResponse });

      const commands = extractCommandRequests(lastResponse);
      const toolCalls = extractToolCalls(lastResponse);
      const fileRequests = extractFileRequests(lastResponse);
      if (commands.length > 0 || toolCalls.length > 0 || fileRequests.length > 0) {
        depth++;
        let executionFeedback = "";
        if (fileRequests.length > 0) {
          executionFeedback +=
            await this.executeFileRequestsFromResponse(lastResponse);
        }
        if (commands.length > 0) {
          executionFeedback +=
            await this.executeCommandsFromResponse(lastResponse);
        }
        if (toolCalls.length > 0) {
          executionFeedback +=
            await this.executeToolCallsFromResponse(lastResponse);
        }
        currentMessages.push({
          role: "user",
          content: `System: Execution results:\n${executionFeedback}\n\nNow continue your process or provide your complete answer using these results.`,
        });
      } else {
        hasMoreCommands = false;
      }
    }

    const allAssistantChunks = currentMessages
      .slice(messagesForModel.length)
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);

    const finalContent = allAssistantChunks.join("\n\n");
    return finalContent
      .replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, "")
      .replace(/<call_tool\s+name="[^"]+">[\s\S]*?<\/call_tool>/gi, "")
      .replace(/<request_files>[\s\S]*?<\/request_files>/gi, "")
      .trim();
  }

  private async generateAgentAssistantResponse(
    messagesForModel: ChatSession["messages"],
  ): Promise<string> {
    const editFormat = getAgentEditFormat();
    const agentProvider = createProviderForMode("agent", this.provider);
    const outcome =
      editFormat === "wholefile"
        ? await executeAgentTurnWholefile({
            provider: agentProvider,
            messagesForModel,
            workspacePath: this.workspacePath,
            logger: this.logger,
            modelOverride: resolveModelForMode("agent"),
          })
        : await executeAgentTurn({
            provider: agentProvider,
            messagesForModel,
            workspacePath: this.workspacePath,
            scannedFiles: this.getWorkspaceFiles(),
            logger: this.logger,
            modelOverride: resolveModelForMode("agent"),
          });

    // Aplica los parches válidos directamente
    if (
      outcome.validProposedPatches &&
      outcome.validProposedPatches.length > 0
    ) {
      const result = await applySREditBatchFS(
        outcome.validProposedPatches,
        this.workspacePath,
      );
      if (result.success) {
        return (
          outcome.response +
          `\n\n---\n[32m[1m${result.results.length} patch(es) applied directly.[0m` +
          result.results
            .map(
              (r) =>
                `\n- ${r.file}: ${r.applied ? "applied" : r.skipped ? "skipped" : "failed"}`,
            )
            .join("")
        );
      } else {
        return (
          outcome.response +
          `\n\n---\n[31m[1mSome patches failed to apply.[0m` +
          result.results
            .map(
              (r) =>
                `\n- ${r.file}: ${r.applied ? "applied" : r.skipped ? "skipped" : "failed"}`,
            )
            .join("")
        );
      }
    }
    const toolCalls = extractToolCalls(outcome.response);
    const commands = extractCommandRequests(outcome.response);

    if (toolCalls.length > 0 || commands.length > 0) {
      let feedback = "\n\n--- Execution Results ---\n";

      for (const call of toolCalls) {
        this.logger.logInfo(`Calling tool: ${call.name}`, { args: call.args });
        try {
          if (call.name === "weather") {
            const weatherRes = await getWeather(call.args.location as string);
            feedback += `\n### 🌤️ Weather: ${call.args.location}\n${formatWeatherOutput(weatherRes)}\n`;
          } else if (call.name === "search") {
            const searchRes = await searchWeb(
              call.args.query as string,
              this.provider,
            );
            feedback += `\n### 🔍 Search Results: ${call.args.query}\n${searchRes}\n`;
          } else {
            throw new Error(`Tool "${call.name}" is not implemented.`);
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          feedback += `\n[TOOL] ${call.name}(${JSON.stringify(call.args)}) -> ERROR: ${errorMsg}\n`;
        }
      }

      for (const cmd of commands) {
        this.logger.logInfo(`Executing command: ${cmd}`);
        const result = await executeCommand(cmd, this.workspacePath);
        this.logger.logCommandExecution(cmd, result);
        feedback += `\n[COMMAND] ${cmd} (Exit: ${result.exitCode})\nStdout: ${result.stdout || "none"}\nStderr: ${result.stderr || "none"}\n`;
      }
      return outcome.response + feedback;
    }
    return outcome.response;
  }

  private buildStuckMessage(
    lastError: string | undefined,
    patches: AgentSREdit[],
  ): string {
    const patchCount = patches.length;
    const errorSection = lastError
      ? `\n**Last validation error:**\n\`\`\`\n${lastError}\n\`\`\``
      : "";

    return [
      `⚠️ The agent couldn't fully validate the proposed changes after multiple attempts.`,
      errorSection,
      ``,
      patchCount > 0
        ? `The **${patchCount} proposed patch(es)** have been queued anyway. Choose your next action:`
        : `No patches were produced. Choose your next action:`,
      ``,
      `  • \`/confirm --force\`  — apply the patches without TS validation (dangerous, use with care)`,
      `  • \`/discard\`          — reject all patches and start over`,
      `  • **Type a hint**     — describe the fix and the agent will retry with your guidance`,
    ].join("\n");
  }

  private initWatcher(): void {
    if (this.watcher) return;

    this.logger.logInfo(
      "Initializing file watcher for incremental AST updates",
    );
    this.watcher = chokidar.watch(
      [
        "**/*.ts",
        "**/*.js",
        "**/*.tsx",
        "**/*.jsx",
        "**/*.html",
        "**/*.css",
        "**/*.scss",
        "**/*.py",
        "**/*.c",
        "**/*.h",
        "**/*.cpp",
        "**/*.hpp",
        "**/*.cc",
        "**/*.cxx",
        "**/*.cs",
        "**/*.rs",
        "**/*.go",
      ],
      {
        cwd: this.workspacePath,
        ignored: [
          "**/node_modules/**",
          "**/dist/**",
          ".rei/**",
          "**/.rei/**",
          "**/.git/**",
          "**/bin/**",
          "**/obj/**",
        ],
        persistent: true,
        ignoreInitial: true,
      },
    );

    const handleChange = async (filePath: string) => {
      this.scanCache = undefined;
      const absPath = path.join(this.workspacePath, filePath);
      const relFilePath = filePath.replace(/\\/g, "/");

      this.vectorStore.deleteByFilePath(relFilePath);

      const newMapString = await generateRepoMapForFile(
        this.workspacePath,
        absPath,
      );
      if (newMapString) {
        const chunks = chunkRepoMapString(newMapString);
        for (const chunk of chunks) {
          const hash = crypto
            .createHash("md5")
            .update(chunk.content)
            .digest("hex");
          const existing = this.vectorStore.getById(chunk.metadata.id);
          if (existing && existing.metadata.fileHash === hash) continue;

          const vector = await generateEmbedding(chunk.content);
          this.vectorStore.upsert(
            {
              ...chunk.metadata,
              content: chunk.content,
              fileHash: hash,
            },
            vector,
          );
        }
      }

      await this.vectorStore.save();
    };

    const handleUnlink = async (filePath: string) => {
      this.scanCache = undefined;
      const relFilePath = filePath.replace(/\\/g, "/");
      this.vectorStore.deleteByFilePath(relFilePath);
      await this.vectorStore.save();
    };

    this.watcher.on("change", handleChange);
    this.watcher.on("add", handleChange);
    this.watcher.on("unlink", handleUnlink);
  }
}
