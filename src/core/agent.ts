import type { ModelProvider } from "../providers/model-provider.js";
import type { ChatSession } from "../chat/types.js";
import { generateAgentModeResponse, prepareAgentContext, buildAgentFinalResponse } from "../agent-mode/generator.js";
import { buildSystemMessage } from "../prompts/prompt-builder.js";
import { buildTurnContext, type TurnContext } from "../context/context-builder.js";
import { buildMessagesForModel } from "../chat/message-builder.js";
import { scanWorkspace, type FileMeta } from "../workspace/workspace-scanner.js";
import { applyPatchBatch, runWorkspaceTypecheck, type BatchPatchApplyResult } from "../tools/patch-applier.js";
import { validatePatchProposal } from "../tools/patch-validator.js";
import type { AgentProposedPatch } from "../contracts/agent-decision.types.js";
import { KnowledgeOrchestrator } from "../knowledge/orchestrator.js";

const SCAN_CACHE_TTL_MS = 30_000;

export type TurnStatus = "building_context" | "fetching_external_knowledge" | "calling_model" | "producing_response";

type StreamTurnOptions = {
  onStatus?: (status: TurnStatus) => void;
};

export interface PendingPatchAssessmentItem {
  proposal: AgentProposedPatch;
  applicable: boolean;
  safe: boolean;
  issues: string[];
}

export interface PendingPatchAssessment {
  workspaceQualityOk: boolean;
  workspaceQualityStderr: string;
  items: PendingPatchAssessmentItem[];
}

export class Agent {
  private scanCache?: {
    workspacePath: string;
    files: FileMeta[];
    timestamp: number;
  };
  private pendingProposedPatches: AgentProposedPatch[] = [];
  private knowledgeOrchestrator: KnowledgeOrchestrator;

  constructor(
    private readonly provider: ModelProvider,
    private readonly workspacePath: string = process.cwd()
  ) { 
    this.knowledgeOrchestrator = new KnowledgeOrchestrator(this.provider);
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

  async applyPendingPatches(options?: { dryRun?: boolean }): Promise<BatchPatchApplyResult> {
    if (this.pendingProposedPatches.length === 0) {
      return {
        success: false,
        dryRun: options?.dryRun ?? true,
        results: [],
      };
    }

    const result = await applyPatchBatch(this.pendingProposedPatches, this.workspacePath, {
      dryRun: options?.dryRun ?? true,
    });

    if (!options?.dryRun && result.success && result.results.every((r) => r.applied)) {
      this.pendingProposedPatches = [];
    }

    return result;
  }

  async assessPendingPatchesSafety(): Promise<PendingPatchAssessment> {
    const quality = await runWorkspaceTypecheck(this.workspacePath);
    const items: PendingPatchAssessmentItem[] = [];

    for (const proposal of this.pendingProposedPatches) {
      const validation = await validatePatchProposal(proposal, this.workspacePath);
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
    const systemContent = buildSystemMessage(session.mode);

    // Keep the system message at position 0 reflecting the current mode.
    if (session.messages.length > 0 && session.messages[0].role === "system") {
      session.messages[0] = { role: "system", content: systemContent };
    } else {
      session.messages.unshift({ role: "system", content: systemContent });
    }

    const context = await buildTurnContext({
      workspacePath: this.workspacePath,
      userInput,
      mode: session.mode,
      scannedFiles: this.getWorkspaceFiles(),
      knowledgeOrchestrator: this.knowledgeOrchestrator,
    });

    const enrichedMessage = buildTurnUserMessage({ userInput, context });

    session.messages.push({ role: "user", content: enrichedMessage });

    // session.messages holds the complete history; send only a trimmed
    // window to the provider to keep prompt size under control.
    const messagesForModel = buildMessagesForModel(session.messages, session.mode);
    const response = await this.generateAssistantResponse(session.mode, messagesForModel);
    session.messages.push({ role: "assistant", content: response });
    return response;
  }

  async *streamTurn(
    session: ChatSession,
    userInput: string,
    options?: StreamTurnOptions
  ): AsyncIterable<string> {
    options?.onStatus?.("building_context");
    const systemContent = buildSystemMessage(session.mode);

    if (session.messages.length > 0 && session.messages[0].role === "system") {
      session.messages[0] = { role: "system", content: systemContent };
    } else {
      session.messages.unshift({ role: "system", content: systemContent });
    }

    const context = await buildTurnContext({
      workspacePath: this.workspacePath,
      userInput,
      mode: session.mode,
      scannedFiles: this.getWorkspaceFiles(),
      knowledgeOrchestrator: this.knowledgeOrchestrator,
      onStatus: options?.onStatus,
    });

    const enrichedMessage = buildTurnUserMessage({ userInput, context });

    session.messages.push({ role: "user", content: enrichedMessage });

    const messagesForModel = buildMessagesForModel(session.messages, session.mode);
    options?.onStatus?.("calling_model");

    if (session.mode === "agent") {
      const prelude = await prepareAgentContext({
        provider: this.provider,
        messagesForModel,
        workspacePath: this.workspacePath,
        scannedFiles: this.getWorkspaceFiles(),
      });

      options?.onStatus?.("producing_response");

      let answer: string;
      if (this.provider.streamChat) {
        answer = "";
        for await (const token of this.provider.streamChat(prelude.answerMessages)) {
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

      if (outcome.validProposedPatches.length > 0) {
        this.pendingProposedPatches = [
          ...(this.pendingProposedPatches ?? []),
          ...outcome.validProposedPatches,
        ];
      }

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
    messagesForModel: ChatSession["messages"]
  ): Promise<string> {
    if (mode !== "agent") {
      const raw = await this.provider.completeChat(messagesForModel);
      if (looksLikeAgentJson(raw)) {
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
      return raw;
    }

    return generateAgentModeResponse({
      provider: this.provider,
      messagesForModel,
      workspacePath: this.workspacePath,
      scannedFiles: this.getWorkspaceFiles(),
    }).then((outcome) => {
      if (outcome.validProposedPatches && outcome.validProposedPatches.length > 0) {
        this.pendingProposedPatches = [
          ...(this.pendingProposedPatches ?? []),
          ...outcome.validProposedPatches,
        ];
      }
      return outcome.response;
    });
  }
}

export function buildTurnUserMessage(params: {
  userInput: string;
  context: TurnContext;
}): string {
  const { userInput, context } = params;
  const lines: string[] = [];

  lines.push(`Task: ${userInput}`);
  lines.push(``);
  lines.push(`Workspace: ${context.workspacePath}`);
  lines.push(``);
  lines.push(`Repository summary:`);
  lines.push(context.repoSummary);

  if (context.externalKnowledge && context.externalKnowledge.length > 0) {
    lines.push(``);
    lines.push(`External Official Documentation:`);
    lines.push(`These are officially sourced technical references related to the user's task.`);
    context.externalKnowledge.forEach((knowledge, idx) => {
      lines.push(`${idx + 1}. [${knowledge.domain}] ${knowledge.title}`);
      lines.push(`   Source: ${knowledge.url}`);
      lines.push(`   Summary:\n   ${knowledge.content.split('\\n').join('\\n   ')}`);
      lines.push(``);
    });
  }

  if (context.relevantFiles.length > 0) {
    lines.push(``);
    lines.push(`The following files are ALREADY included in this message. Do NOT request them via contextRequests:`);
    for (const file of context.relevantFiles) {
      lines.push(`  - ${file.path}`);
    }
    lines.push(``);
    lines.push(`Important: The file excerpts below may be partial or truncated.
Use only the visible content. Do not reconstruct omitted code.`);
    lines.push(`Relevant files:`);
    for (const file of context.relevantFiles) {
      lines.push(``);
      lines.push(`--- ${file.path} (score: ${file.score}) ---`);
      lines.push(file.preview);
    }
  }

  return lines.join("\n");
}

/**
 * Heuristic to detect when a non-agent mode response looks like an agent
 * JSON contract object. Checks for the structural fingerprint of AgentResponse
 * (top-level keys "version", "mode", "actions") without full parsing.
 */
function looksLikeAgentJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) return false;
  return (
    /"version"\s*:/.test(trimmed) &&
    /"mode"\s*:\s*"agent"/.test(trimmed) &&
    /"actions"\s*:/.test(trimmed)
  );
}
