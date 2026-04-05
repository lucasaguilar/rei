import type { ModelProvider } from "../providers/model-provider.js";
import {
  generateAgentModeResponse,
  prepareAgentContext,
  buildAgentFinalResponse,
} from "../agent-mode/generator.js";
import { buildSystemMessage } from "../prompts/prompt-builder.js";
import { buildTurnContext } from "../context/context-builder.js";
import { buildMessagesForModel } from "../chat/message-builder.js";
import { compactSession, needsCompaction } from "../chat/compactor.js";
import { type ChatSession } from "../chat/types.js";
import {
  scanWorkspace,
  type FileMeta,
} from "../workspace/workspace-scanner.js";
import {
  applyPatchBatch,
  runWorkspaceTypecheck,
  type BatchPatchApplyResult,
} from "../tools/patch-applier.js";
import { validatePatchProposal } from "../tools/patch-validator.js";
import type { AgentProposedPatch } from "../contracts/agent-decision.types.js";
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
  private pendingProposedPatches: AgentProposedPatch[] = [];
  private knowledgeOrchestrator: KnowledgeOrchestrator;
  public logger: AgentLogger;
  public readonly provider: ModelProvider;
  private readonly workspacePath: string;

  constructor(provider: ModelProvider, workspacePath: string = process.cwd()) {
    this.provider = provider;
    this.workspacePath = workspacePath;
    this.knowledgeOrchestrator = new KnowledgeOrchestrator(this.provider);
    this.logger = new AgentLogger(workspacePath);
  }

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
  }

  hasPendingPatches(): boolean {
    return this.pendingProposedPatches.length > 0;
  }

  getPendingPatches(): AgentProposedPatch[] {
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
        dryRun: options?.dryRun ?? true,
        results: [],
      };
    }

    const result = await applyPatchBatch(
      this.pendingProposedPatches,
      this.workspacePath,
      {
        dryRun: options?.dryRun ?? true,
      },
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
    const quality = await runWorkspaceTypecheck(this.workspacePath);
    const items: PendingPatchAssessmentItem[] = [];

    for (const proposal of this.pendingProposedPatches) {
      const validation = await validatePatchProposal(
        proposal,
        this.workspacePath,
      );
      const applicable = validation.valid;
      const safe = applicable && quality.ok;
      const issues = validation.issues.map((issue) => issue.message);
      if (!quality.ok) {
        issues.push("Workspace quality gate failed: npm run check");
      }

      items.push({
        proposal,
        applicable,
        safe,
        issues,
      });
    }

    return {
      workspaceQualityOk: quality.ok,
      workspaceQualityStderr: quality.stderr,
      items,
    };
  }

  async runTurn(session: ChatSession, userInput: string): Promise<string> {
    this.logger.startTurn();
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
    await this.prepareSessionForTurn(session, userInput, options?.onStatus);
    await this.compactSessionIfNeeded(session, options?.onStatus);

    const messagesForModel = buildMessagesForModel(
      session.messages,
      session.mode,
    );
    options?.onStatus?.("calling_model");

    if (session.mode === "agent") {
      const prelude = await prepareAgentContext({
        provider: this.provider,
        messagesForModel,
        workspacePath: this.workspacePath,
        scannedFiles: this.getWorkspaceFiles(),
        logger: this.logger,
      });

      options?.onStatus?.("producing_response");

      let answer: string;
      if (this.provider.streamChat) {
        answer = "";
        for await (const token of this.provider.streamChat(
          prelude.answerMessages,
        )) {
          answer += token;
          yield token;
        }
      } else {
        answer = await this.provider.completeChat(prelude.answerMessages);
        // In the non-streaming branch, yield the full answer so callers receive
        // the main assistant output before any additional patch section.
        yield answer;
      }

      const outcome = buildAgentFinalResponse(answer, prelude);
      this.appendPendingProposedPatches(outcome.validProposedPatches ?? []);

      // Yield patch section as extra chunk if present
      const patchSection = outcome.response.slice(answer.length);
      if (patchSection) {
        yield patchSection;
      }

      session.messages.push({ role: "assistant", content: outcome.response });
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

  private ensureSystemMessage(session: ChatSession): void {
    const systemContent = buildSystemMessage(session.mode);

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
    this.ensureSystemMessage(session);

    const context = await buildTurnContext({
      workspacePath: this.workspacePath,
      scannedFiles: this.getWorkspaceFiles(),
      userInput,
      mode: session.mode,
      knowledgeOrchestrator: this.knowledgeOrchestrator,
      onStatus,
    });

    if (context.ragResults && context.ragResults.length > 0) {
      this.logger.logRagSearch(
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

  private appendPendingProposedPatches(patches: AgentProposedPatch[]): void {
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
}
