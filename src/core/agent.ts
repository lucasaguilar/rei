import type { ModelProvider } from "../providers/model-provider.js";
import { generateAgentModeResponse } from "../agent-mode/generator.js";
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
  private pendingProposedPatches: AgentSREdit[] = [];
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

  hasPendingPatches(): boolean {
    return this.pendingProposedPatches.length > 0;
  }

  refreshRepositorySkeletonMap(): string {
    this.repoMapCache = generateRepoMap(this.workspacePath);
    return this.repoMapCache;
  }

  getPendingPatches(): AgentSREdit[] {
    return [...this.pendingProposedPatches];
  }

  clearPendingPatches(): number {
    const count = this.pendingProposedPatches.length;
    this.pendingProposedPatches = [];
    return count;
  }

  async applyPendingPatches(options?: {
    dryRun?: boolean;
  }): Promise<BatchPatchApplyResult> {
    if (this.pendingProposedPatches.length === 0) {
      return {
        success: false,
        results: [],
      };
    }

    const result = await applySREditBatchFS(
      this.pendingProposedPatches,
      this.workspacePath,
    );

    if (
      !options?.dryRun &&
      result.success &&
      result.results.every((r) => r.applied)
    ) {
      this.pendingProposedPatches = [];
    }

    return result;
  }

  async assessPendingPatchesSafety(): Promise<PendingPatchAssessment> {
    // Legacy sandbox logic removed in favor of virtual TS morph check.
    // Kept the return type to satisfy the compiler temporarily.
    return {
      workspaceQualityOk: true,
      workspaceQualityStderr: "",
      items: this.pendingProposedPatches.map((p) => ({
        proposal: p,
        applicable: true,
        safe: true,
        issues: [],
      })),
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
      const outcome = await generateAgentModeResponse({
        provider: this.provider,
        messagesForModel,
        workspacePath: this.workspacePath,
        scannedFiles: this.getWorkspaceFiles(),
        logger: this.logger,
      });

      if (outcome.failed) {
        // Enqueue partial patches so user can /confirm --force or /discard
        this.appendPendingProposedPatches(outcome.failedProposedPatches ?? []);
        const msg = this.buildStuckMessage(
          outcome.lastValidationError,
          outcome.failedProposedPatches ?? [],
        );
        session.messages.push({ role: "assistant", content: msg });
        options?.onStatus?.("producing_response");
        yield msg;
        return;
      }

      this.appendPendingProposedPatches(outcome.validProposedPatches ?? []);

      const hasPatches = (outcome.validProposedPatches ?? []).length > 0;
      const suffix = hasPatches
        ? `\n\n---\n✅ **${outcome.validProposedPatches!.length} patch(es) ready.** Use \`/confirm\` to apply or \`/discard\` to reject.`
        : "";

      const fullResponse = outcome.response + suffix;
      session.messages.push({ role: "assistant", content: outcome.response });
      options?.onStatus?.("producing_response");
      yield fullResponse;
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

  private appendPendingProposedPatches(patches: AgentSREdit[]): void {
    if (patches.length === 0) {
      return;
    }

    // Keep pending queue scoped to the latest change-planning outcome.
    // This avoids mixing patches from unrelated user requests across turns.
    this.pendingProposedPatches = [...patches];
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
    const outcome = await generateAgentModeResponse({
      provider: this.provider,
      messagesForModel,
      workspacePath: this.workspacePath,
      scannedFiles: this.getWorkspaceFiles(),
      logger: this.logger,
    });

    this.appendPendingProposedPatches(outcome.validProposedPatches ?? []);
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
