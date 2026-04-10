import type { ModelProvider } from "../providers/model-provider.js";
import { executeAgentTurn } from "../agent-mode/generator.js";
import { buildSystemMessage } from "../prompts/prompt-builder.js";
import { buildTurnContext } from "../context/context-builder.js";
import { buildMessagesForModel } from "../chat/message-builder.js";
import { compactSession, needsCompaction } from "../chat/compactor.js";
import { type ChatSession } from "../chat/types.js";
import { generateRepoMap } from "../tools/repo-map-generator.js";
import {
  scanWorkspace,
  type FileMeta,
} from "../workspace/workspace-scanner.js";
import {
  applySREditBatchFS,
  type BatchPatchApplyResult,
} from "../tools/patch-applier.js";
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
  private repoMapCache?: string;
  public logger: AgentLogger;
  public readonly provider: ModelProvider;
  private readonly workspacePath: string;
  private correlationId: string;

  constructor(provider: ModelProvider, workspacePath: string = process.cwd()) {
    this.provider = provider;
    this.workspacePath = workspacePath;
    this.knowledgeOrchestrator = new KnowledgeOrchestrator(this.provider);
    this.logger = new AgentLogger(workspacePath);
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
    await this.prepareSessionForTurn(session, userInput);
    await this.compactSessionIfNeeded(session);

    // session.messages holds the complete history; send only a trimmed
    // window to the provider to keep prompt size under control.
    const messagesForModel = buildMessagesForModel(
      session.messages,
      session.mode,
    );
    const response = await this.generateAssistantResponse(
      session.mode,
      messagesForModel,
    );
    session.messages.push({ role: "assistant", content: response });
    return response;
  }

  async *streamTurn(
    session: ChatSession,
    userInput: string,
    options?: StreamTurnOptions,
  ): AsyncIterable<string> {
    this.logger.startTurn();
    this.logger.setCorrelationId(this.correlationId);
    await this.prepareSessionForTurn(session, userInput, options?.onStatus);
    await this.compactSessionIfNeeded(session, options?.onStatus);

    const messagesForModel = buildMessagesForModel(
      session.messages,
      session.mode,
    );
    options?.onStatus?.("calling_model");

    if (session.mode === "agent") {
      const outcome = await executeAgentTurn({
        provider: this.provider,
        messagesForModel,
        workspacePath: this.workspacePath,
        scannedFiles: this.getWorkspaceFiles(),
        logger: this.logger,
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

      // Si no hay parches válidos, solo responde
      session.messages.push({ role: "assistant", content: outcome.response });
      options?.onStatus?.("producing_response");
      yield outcome.response;
      return;
    }

    if (this.provider.streamChat) {
      let fullResponse = "";
      options?.onStatus?.("producing_response");
      for await (const token of this.provider.streamChat(messagesForModel)) {
        fullResponse += token;
        yield token;
      }
      session.messages.push({ role: "assistant", content: fullResponse });
    } else {
      const response = await this.provider.completeChat(messagesForModel);
      session.messages.push({ role: "assistant", content: response });
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

  private async ensureSystemMessage(session: ChatSession): Promise<void> {
    const repositorySkeletonMap =
      session.mode === "agent"
        ? (this.repoMapCache ??
          (this.repoMapCache = generateRepoMap(this.workspacePath)))
        : undefined;
    const systemContent = buildSystemMessage(
      session.mode,
      repositorySkeletonMap,
    );

    if (session.messages.length > 0 && session.messages[0].role === "system") {
      session.messages[0] = { role: "system", content: systemContent };
    } else {
      session.messages.unshift({ role: "system", content: systemContent });
    }
  }

  private async prepareSessionForTurn(
    session: ChatSession,
    userInput: string,
    onStatus?: StreamTurnOptions["onStatus"],
  ): Promise<void> {
    onStatus?.("building_context");
    await this.ensureSystemMessage(session);
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

    const enrichedMessage = buildTurnUserMessage({ userInput, context });
    session.messages.push({ role: "user", content: enrichedMessage });
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
    const raw = await this.provider.completeChat(messagesForModel);
    if (!looksLikeAgentJson(raw)) {
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

    const retried = await this.provider.completeChat(retryMessages);
    if (looksLikeAgentJson(retried)) {
      return `I'm in ${mode} mode and my response came out as structured JSON, which is not valid here. Please rephrase your question or switch to agent mode if you need structured output.`;
    }

    return retried;
  }

  private async generateAgentAssistantResponse(
    messagesForModel: ChatSession["messages"],
  ): Promise<string> {
    const outcome = await executeAgentTurn({
      provider: this.provider,
      messagesForModel,
      workspacePath: this.workspacePath,
      scannedFiles: this.getWorkspaceFiles(),
      logger: this.logger,
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
}
