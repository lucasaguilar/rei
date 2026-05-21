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
import { executeCommand } from "../tools/command-executor.js";
import { extractCommandRequests } from "../agent-mode/response-handler.js";
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
        return;
      }

      // Interceptación de comandos antes de finalizar el turno
      const commands = extractCommandRequests(outcome.response);
      if (commands.length > 0) {
        let commandFeedback = "\n\n--- Command Execution Results ---\n";
        for (const cmd of commands) {
          this.logger.logInfo(`Executing command: ${cmd}`);
          const result = await executeCommand(cmd, this.workspacePath);
          this.logger.logCommandExecution(cmd, result);
          commandFeedback += `\nCommand: ${cmd}\nExit Code: ${result.exitCode}\nStdout: ${result.stdout || "none"}\nStderr: ${result.stderr || "none"}\n`;
        }
        session.messages.push({ role: "assistant", content: outcome.response });
        session.messages.push({
          role: "user",
          content: `System Feedback: ${commandFeedback}`,
        });
        options?.onStatus?.("producing_response");
        yield outcome.response + commandFeedback;
        return;
      }

      // Si no hay parches ni comandos, solo responde
      session.messages.push({ role: "assistant", content: outcome.response });
      options?.onStatus?.("producing_response");
      yield outcome.response;
      return;
    }

    if (this.provider.streamChat) {
      let firstResponse = "";
      options?.onStatus?.("producing_response");
      for await (const token of this.provider.streamChat(messagesForModel, {
        model: resolveModelForMode(session.mode),
      })) {
        firstResponse += token;
        yield token;
      }
      const commands = extractCommandRequests(firstResponse);
      if (commands.length > 0) {
        const cmdFeedback =
          await this.executeCommandsFromResponse(firstResponse);
        yield cmdFeedback;
        const feedbackMessages: ChatSession["messages"] = [
          ...messagesForModel,
          { role: "assistant", content: firstResponse },
          {
            role: "user",
            content: `System: Command execution results:\n${cmdFeedback}\n\nNow provide your complete answer using these results.`,
          },
        ];
        options?.onStatus?.("producing_response");
        let finalResponse = "";
        for await (const token of this.provider.streamChat(feedbackMessages, {
          model: resolveModelForMode(session.mode),
        })) {
          finalResponse += token;
          yield token;
        }
        const firstWithoutCmds = firstResponse
          .replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, "")
          .trim();
        session.messages.push({
          role: "assistant",
          content:
            (firstWithoutCmds ? firstWithoutCmds + "\n\n" : "") +
            cmdFeedback +
            "\n\n" +
            finalResponse,
          sourceMode: session.mode,
        });
      } else {
        session.messages.push({
          role: "assistant",
          content: firstResponse,
          sourceMode: session.mode,
        });
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

    // Rebuild system message only when it doesn't exist yet or mode changed.
    // Keeping it stable across turns preserves the Ollama KV cache prefix.
    const needsRebuild =
      session.messages.length === 0 ||
      session.messages[0].role !== "system" ||
      !session.messages[0].content.includes(`Active mode: ${session.mode}`);

    if (needsRebuild) {
      const systemContent = buildSystemMessage(
        session.mode,
        this.workspacePath,
      );
      if (
        session.messages.length > 0 &&
        session.messages[0].role === "system"
      ) {
        session.messages[0] = { role: "system", content: systemContent };
      } else {
        session.messages.unshift({ role: "system", content: systemContent });
      }
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

  /** Executes any <execute_command> tags found in a response and returns formatted feedback. */
  private async executeCommandsFromResponse(response: string): Promise<string> {
    const commands = extractCommandRequests(response);
    if (commands.length === 0) return "";

    let feedback = "\n\n---\n**Command Results:**\n```\n";
    for (const cmd of commands) {
      this.logger.logInfo(`Executing command: ${cmd}`);
      const result = await executeCommand(cmd, this.workspacePath);
      this.logger.logCommandExecution(cmd, result);
      const output = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      feedback += `$ ${cmd}\n${output || "(no output)"} [exit: ${result.exitCode}]\n\n`;
    }
    feedback += "```";
    return feedback;
  }

  private async generateNonAgentAssistantResponse(
    mode: ChatSession["mode"],
    messagesForModel: ChatSession["messages"],
  ): Promise<string> {
    const raw = await this.provider.completeChat(messagesForModel, {
      model: resolveModelForMode(mode),
    });
    if (!looksLikeAgentJson(raw)) {
      const commands = extractCommandRequests(raw);
      if (commands.length > 0) {
        const cmdFeedback = await this.executeCommandsFromResponse(raw);
        const rawWithoutCmds = raw
          .replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, "")
          .trim();
        const feedbackMessages: ChatSession["messages"] = [
          ...messagesForModel,
          { role: "assistant", content: raw },
          {
            role: "user",
            content: `System: Command execution results:\n${cmdFeedback}\n\nNow provide your complete answer using these results.`,
          },
        ];
        const finalResponse = await this.provider.completeChat(
          feedbackMessages,
          { model: resolveModelForMode(mode) },
        );
        return (
          (rawWithoutCmds ? rawWithoutCmds + "\n\n" : "") +
          cmdFeedback +
          "\n\n" +
          finalResponse
        );
      }
      return raw;
    }

    const retryMessages: ChatSession["messages"] = [
      ...messagesForModel,
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

    const cmdFeedback = await this.executeCommandsFromResponse(retried);
    return retried + cmdFeedback;
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
    const commands = extractCommandRequests(outcome.response);
    if (commands.length > 0) {
      let commandFeedback = "\n\n--- Command Execution Results ---\n";
      for (const cmd of commands) {
        this.logger.logInfo(`Executing command: ${cmd}`);
        const result = await executeCommand(cmd, this.workspacePath);
        this.logger.logCommandExecution(cmd, result);
        commandFeedback += `\nCommand: ${cmd}\nExit Code: ${result.exitCode}\nStdout: ${result.stdout || "none"}\nStderr: ${result.stderr || "none"}\n`;
      }
      return outcome.response + commandFeedback;
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
