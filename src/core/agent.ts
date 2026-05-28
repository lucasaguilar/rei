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
import { VectorStore } from "../context/rag/vector-store.js";
import { getRelevantMapContext } from "../context/rag/map-retriever.js";
import type { FSWatcher } from "chokidar";
import {
  scanWorkspace,
  type FileMeta,
} from "../workspace/workspace-scanner.js";
import { applySREditBatchFS } from "../tools/patch-applier.js";
import {
  extractCommandRequests,
  extractToolCalls,
  extractFileRequests,
} from "../agent-mode/response-handler.js";
import { KnowledgeOrchestrator } from "../knowledge/orchestrator.js";
import { AgentLogger } from "./logger.js";
import { SCAN_CACHE_TTL_MS } from "./constants/agent.constants.js";
import {
  buildTurnUserMessage,
  looksLikeAgentJson,
  extractStageNumberFromPrompt,
  stripActionTags,
} from "./helpers/turn-message.helpers.js";
import type { StreamTurnOptions } from "./models/agent.types.js";
import {
  executeFileRequestsFromResponse,
  executeCommandsFromResponse,
  executeToolCallsFromResponse,
  executeAgentToolsAndCommands,
  formatBatchPatchResult,
  executeAndFormatTurnActions,
} from "./helpers/action-executor.js";
import {
  ensureRepoMapIndexed,
  initWatcher,
} from "./helpers/repo-map-indexer.js";

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
        const wasSuccessful =
          response.includes("patch(es) applied directly.") ||
          response.includes("file(s) written.");
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
      const chunksQueue: string[] = [];
      let resolver: (() => void) | null = null;
      let done = false;

      const onChunk = (chunk: { type: "thinking" | "status"; content: string }) => {
        chunksQueue.push(chunk.content);
        resolver?.();
      };

      const turnPromise = (
        editFormat === "wholefile"
          ? executeAgentTurnWholefile({
              provider: agentProvider,
              messagesForModel,
              workspacePath: this.workspacePath,
              logger: this.logger,
              modelOverride: resolveModelForMode("agent"),
              onChunk,
            })
          : executeAgentTurn({
              provider: agentProvider,
              messagesForModel,
              workspacePath: this.workspacePath,
              scannedFiles: this.getWorkspaceFiles(),
              logger: this.logger,
              modelOverride: resolveModelForMode("agent"),
              onChunk,
            })
      ).finally(() => {
        done = true;
        resolver?.();
      });

      // Stream thoughts and action statuses to the user in real-time
      while (!done || chunksQueue.length > 0) {
        if (chunksQueue.length > 0) {
          yield chunksQueue.shift()!;
        } else {
          await new Promise<void>((resolve) => {
            resolver = resolve;
          });
        }
      }

      const outcome = await turnPromise;

      // Si hay parches válidos, aplicarlos directamente
      if (
        outcome.validProposedPatches &&
        outcome.validProposedPatches.length > 0
      ) {
        const result = await applySREditBatchFS(
          outcome.validProposedPatches,
          this.workspacePath,
        );
        const msg = formatBatchPatchResult(result);
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
      const feedback = await executeAgentToolsAndCommands(
        outcome.response,
        this.workspacePath,
        this.provider,
        this.logger,
      );

      if (feedback) {
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
      const maxDepth = process.env.REI_MAX_TURNS
        ? parseInt(process.env.REI_MAX_TURNS, 10)
        : 7;

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

        if (
          commands.length > 0 ||
          toolCalls.length > 0 ||
          fileRequests.length > 0
        ) {
          // Yield the visible part of the response (strip XML tags) before
          // the tool-result block so the user sees the prose intro, if any.
          const visibleResponse = stripActionTags(streamResponse);
          if (visibleResponse) {
            yield visibleResponse + "\n";
          }

          depth++;
          const { executionFeedback, userVisibleFeedback } = await executeAndFormatTurnActions({
            response: streamResponse,
            workspacePath: this.workspacePath,
            provider: this.provider,
            logger: this.logger,
          });

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
          const cleanAssistantContent = stripActionTags(finalContent);

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
    onStatus?: StreamTurnOptions["onStatus"],
  ): Promise<string | undefined> {
    let repositorySkeletonMap: string | undefined = undefined;

    // 1. Asegurar que el mapa esté generado e indexado en el VectorStore
    if (!this.repoMapCache) {
      this.repoMapCache = await ensureRepoMapIndexed({
        workspacePath: this.workspacePath,
        vectorStore: this.vectorStore,
        logger: this.logger,
        onStatus,
      });

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

    if (session.messages.length > 0 && session.messages[0].role === "system") {
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
      onStatus,
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

  private async generateNonAgentAssistantResponse(
    mode: ChatSession["mode"],
    messagesForModel: ChatSession["messages"],
  ): Promise<string> {
    let currentMessages = [...messagesForModel];
    let hasMoreCommands = true;
    let depth = 0;
    const maxDepth = process.env.REI_MAX_TURNS
      ? parseInt(process.env.REI_MAX_TURNS, 10)
      : 7;
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
      if (
        commands.length > 0 ||
        toolCalls.length > 0 ||
        fileRequests.length > 0
      ) {
        depth++;
        let executionFeedback = "";
        if (fileRequests.length > 0) {
          executionFeedback += await executeFileRequestsFromResponse(
            lastResponse,
            this.workspacePath,
            this.logger,
          );
        }
        if (commands.length > 0) {
          executionFeedback += await executeCommandsFromResponse(
            lastResponse,
            this.workspacePath,
            this.logger,
          );
        }
        if (toolCalls.length > 0) {
          executionFeedback += await executeToolCallsFromResponse(
            lastResponse,
            this.provider,
            this.logger,
          );
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
    return stripActionTags(finalContent);
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
      const msg = formatBatchPatchResult(result);
      return outcome.response + msg;
    }
    const feedback = await executeAgentToolsAndCommands(
      outcome.response,
      this.workspacePath,
      this.provider,
      this.logger,
    );
    return outcome.response + feedback;
  }

  private initWatcher(): void {
    if (this.watcher) return;
    this.watcher = initWatcher({
      workspacePath: this.workspacePath,
      vectorStore: this.vectorStore,
      logger: this.logger,
      clearScanCache: () => {
        this.scanCache = undefined;
      },
    });
  }
}
