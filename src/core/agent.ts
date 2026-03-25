import * as path from "path";
import { jsonrepair } from "jsonrepair";
import type { ModelProvider } from "../providers/model-provider.js";
import type { ChatSession } from "../chat/types.js";
import {
  parseAgentResponse,
  validateAgentResponse,
  type AgentResponse,
} from "../contracts/agent-response.types.js";
import { buildSystemMessage } from "../prompts/prompt-builder.js";
import { buildTurnContext, type TurnContext } from "../context/context-builder.js";
import { buildMessagesForModel } from "../chat/message-builder.js";
import { scanWorkspace, type FileMeta } from "../workspace/workspace-scanner.js";

const SCAN_CACHE_TTL_MS = 30_000;
const AGENT_JSON_REPAIR_RETRIES = 1;

export type TurnStatus = "building_context" | "calling_model" | "producing_response";

type StreamTurnOptions = {
  onStatus?: (status: TurnStatus) => void;
};

type ParseRecoveryStage = "direct" | "sanitized" | "repaired";

export class Agent {
  private scanCache?: {
    workspacePath: string;
    files: FileMeta[];
    timestamp: number;
  };

  constructor(
    private readonly provider: ModelProvider,
    private readonly workspacePath: string = process.cwd()
  ) { }

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
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
    });

    debugContext(context);

    const enrichedMessage = buildTurnUserMessage({ userInput, context });

    session.messages.push({ role: "user", content: enrichedMessage });

    // session.messages holds the complete history; send only a trimmed
    // window to the provider to keep prompt size under control.
    const messagesForModel = buildMessagesForModel(session.messages);
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
    });

    debugContext(context);

    const enrichedMessage = buildTurnUserMessage({ userInput, context });

    session.messages.push({ role: "user", content: enrichedMessage });

    const messagesForModel = buildMessagesForModel(session.messages);
    options?.onStatus?.("calling_model");

    if (session.mode === "agent") {
      const response = await this.generateAssistantResponse(session.mode, messagesForModel);
      session.messages.push({ role: "assistant", content: response });
      options?.onStatus?.("producing_response");
      yield response;
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
      return this.provider.completeChat(messagesForModel);
    }

    let rawResponse = await this.provider.completeChat(messagesForModel);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= AGENT_JSON_REPAIR_RETRIES; attempt += 1) {
      try {
        const normalized = normalizeAgentResponsePaths(rawResponse, this.workspacePath);
        const recovered = parseAgentResponseWithRecovery(normalized);
        const semanticIssues = validateAgentResponseSemantics(recovered.response, messagesForModel);
        if (semanticIssues.length > 0) {
          throw new Error(`Invalid AGENT mode semantic response: ${semanticIssues.join("; ")}`);
        }
        if (recovered.stage !== "direct") {
          console.warn(`[REI debug] Agent JSON recovered via: ${recovered.stage}`);
        }
        return JSON.stringify(recovered.response, null, 2);
      } catch (error: unknown) {
        if (!(error instanceof Error)) {
          throw error;
        }
        lastError = error;

        if (attempt === AGENT_JSON_REPAIR_RETRIES) {
          break;
        }

        const repairMessages: ChatSession["messages"] = [
          ...messagesForModel,
          {
            role: "user",
            content: buildAgentRepairPrompt(error.message),
          },
        ];

        rawResponse = await this.provider.completeChat(repairMessages);
      }
    }

    console.warn(
      `[REI debug] Agent mode fallback engaged after ${AGENT_JSON_REPAIR_RETRIES + 1} attempt(s): ${lastError?.message ?? "unknown validation error"}`
    );

    return JSON.stringify(buildDegradedAgentFallback(rawResponse, lastError), null, 2);
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

  if (context.relevantFiles.length > 0) {
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

function debugContext(context: TurnContext): void {
  const scannedNote = `[REI debug] Workspace: ${path.resolve(context.workspacePath)}`;
  const filesNote = `[REI debug] Relevant files selected: ${context.relevantFiles.length}`;
  const fileList = context.relevantFiles
    .map((f) => `  - ${f.path} (score: ${f.score})`)
    .join("\n");

  console.log(scannedNote);
  console.log(filesNote);
  if (fileList) console.log(fileList);
}

function parseAgentResponseWithRecovery(rawResponse: string): {
  response: AgentResponse;
  stage: ParseRecoveryStage;
} {
  try {
    return { response: parseAgentResponse(rawResponse), stage: "direct" };
  } catch {
    // continue with conservative recovery steps
  }

  const sanitized = sanitizeAgentJsonText(rawResponse);
  if (sanitized) {
    try {
      return { response: parseAgentResponse(sanitized), stage: "sanitized" };
    } catch {
      // continue with syntactic repair
    }

    try {
      const repaired = jsonrepair(sanitized);
      return { response: parseAgentResponse(repaired), stage: "repaired" };
    } catch {
      // fall through to throw original parse error below
    }
  }

  return { response: parseAgentResponse(rawResponse), stage: "direct" };
}

function buildAgentRepairPrompt(validationError: string): string {
  const isSemantic = validationError.includes("semantic");
  const isPathError = validationError.includes("workspace-relative path");

  const extra: string[] = [];

  if (isSemantic) {
    extra.push(
      "IMPORTANT: Write summary and finalMessage in proposal tense (e.g. \"Propose to add…\", \"Would add…\"), not as if the change already happened.",
      "If the task requests a repository change, include at least one modify action or one proposedChange."
    );
  }

  if (isPathError) {
    extra.push(
      "IMPORTANT: All file paths (in actions[].target, proposedChanges[].file, contextRequests[].path) must be workspace-relative (e.g. \"src/main.ts\", NOT \"/workspaces/rei/src/main.ts\")."
    );
  }

  return [
    "Your previous AGENT mode response failed validation.",
    `Validation error: ${validationError}`,
    "Return a corrected response as raw JSON only.",
    "Do not include markdown fences or extra prose.",
    "The first character of your response must be { and the last character must be }.",
    "Your response must not contain triple backticks anywhere.",
    "Keep the same intent and include every required field from the AGENT contract.",
    ...extra,
  ].join("\n");
}

function sanitizeAgentJsonText(rawResponse: string): string {
  let candidate = rawResponse.trim();
  if (!candidate) return "";

  // Strip UTF-8 BOM when present.
  if (candidate.charCodeAt(0) === 0xfeff) {
    candidate = candidate.slice(1);
  }

  // Remove markdown fences if model wrapped JSON in a code block.
  candidate = candidate
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // If additional prose exists, extract the likely JSON object region.
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1).trim();
  }

  return candidate;
}

function normalizeAgentResponsePaths(raw: string, workspacePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // leave as-is; recovery steps will handle parse failure
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return raw;
  }

  const record = parsed as Record<string, unknown>;
  const absoluteBase = path.resolve(workspacePath).replace(/\\/g, "/");

  function stripWorkspacePrefix(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const normalized = value.replace(/\\/g, "/");
    if (normalized.startsWith(absoluteBase + "/")) {
      return normalized.slice(absoluteBase.length + 1);
    }
    return value;
  }

  if (Array.isArray(record.actions)) {
    record.actions = (record.actions as unknown[]).map((action) => {
      if (typeof action === "object" && action !== null) {
        const a = action as Record<string, unknown>;
        return { ...a, target: stripWorkspacePrefix(a.target) };
      }
      return action;
    });
  }

  if (Array.isArray(record.proposedChanges)) {
    record.proposedChanges = (record.proposedChanges as unknown[]).map((change) => {
      if (typeof change === "object" && change !== null) {
        const c = change as Record<string, unknown>;
        return { ...c, file: stripWorkspacePrefix(c.file) };
      }
      return change;
    });
  }

  if (Array.isArray(record.contextRequests)) {
    record.contextRequests = (record.contextRequests as unknown[]).map((req) => {
      if (typeof req === "object" && req !== null) {
        const r = req as Record<string, unknown>;
        return { ...r, path: stripWorkspacePrefix(r.path) };
      }
      return req;
    });
  }

  return JSON.stringify(record);
}

function buildDegradedAgentFallback(
  rawResponse: string,
  error?: Error
): AgentResponse {
  const excerpt = sanitizeAgentJsonText(rawResponse).slice(0, 240);
  const detail = error?.message ?? "unknown parsing/validation error";

  const fallback: AgentResponse = validateAgentResponse({
    version: "1.0",
    mode: "agent",
    summary:
      "The model returned a non-conforming AGENT response; REI produced a degraded fallback.",
    confidence: 0,
    needsMoreContext: false,
    contextRequests: [],
    actions: [],
    proposedChanges: [],
    risks: [
      {
        label: "non-conforming-agent-output",
        detail: `Model output could not be parsed/validated (${detail}).`,
      },
    ],
    finalMessage: excerpt
      ? `The model response was not valid for the AGENT contract. Sanitized excerpt: ${excerpt}`
      : "The model response was not valid for the AGENT contract and could not be recovered.",
  });

  return fallback;
}

function validateAgentResponseSemantics(
  response: AgentResponse,
  messagesForModel: ChatSession["messages"]
): string[] {
  const issues: string[] = [];
  const task = extractCurrentTask(messagesForModel);
  const analysisIntent = isAnalysisIntent(task);

  if (analysisIntent && response.actions.some((action) => action.type === "modify")) {
    issues.push("analysis intent should not include modify actions");
  }

  if (analysisIntent && response.proposedChanges.length > 0) {
    issues.push("analysis intent should not include proposedChanges");
  }

  // Execution-claim check: only applies to pure analysis tasks where no
  // repository changes were requested. Mutation tasks (add/fix/update/…)
  // may legitimately use past tense to summarise their proposal.
  if (analysisIntent) {
    if (containsExecutionClaim(response.summary)) {
      issues.push("analysis task: summary must not claim changes were already applied");
    }
    if (containsExecutionClaim(response.finalMessage)) {
      issues.push("analysis task: finalMessage must not claim changes were already applied");
    }
  }

  // Mutation-intent check: if the user asked for a change, expect at least
  // a modify action or a proposedChange describing what would be done.
  if (!analysisIntent) {
    const hasMutationAction = response.actions.some((a) => a.type === "modify");
    if (!hasMutationAction && response.proposedChanges.length === 0) {
      issues.push("mutation task: response should include a modify action or at least one proposedChange");
    }
  }

  return issues;
}

function extractCurrentTask(messagesForModel: ChatSession["messages"]): string {
  for (let i = messagesForModel.length - 1; i >= 0; i -= 1) {
    const message = messagesForModel[i];
    if (message.role !== "user") continue;

    const taskLine = message.content
      .split("\n")
      .find((line) => line.toLowerCase().startsWith("task:"));

    if (taskLine) {
      return taskLine.slice("Task:".length).trim();
    }

    return message.content.trim();
  }

  return "";
}

function isAnalysisIntent(task: string): boolean {
  const normalized = task.toLowerCase();
  if (!normalized) return false;

  const analysisPattern = /\b(analy[sz]e|analysis|review|inspect|explain|understand|diagnos(?:e|is)|analizy)\b/;
  const mutationPattern = /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch)\b/;

  return analysisPattern.test(normalized) && !mutationPattern.test(normalized);
}

function containsExecutionClaim(text: string): boolean {
  const executionPattern =
    /\b(added|updated|modified|changed|implemented|fixed|removed|created|wrote|inserted|applied|done)\b/i;
  return executionPattern.test(text);
}
