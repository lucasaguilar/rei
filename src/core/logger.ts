import * as fs from "fs";
import * as path from "path";
import { ensureReiDirIgnored } from "../workspace/rei-dir.js";

export interface LogEntry {
  timestamp: string;
  turnId: string;
  correlationId?: string;
  phase:
    | "USER_PROMPT"
    | "DECISION"
    | "KNOWLEDGE"
    | "PATCH_PROPOSED"
    | "AST_CRITIC_LOOP"
    | "AST_CONTEXT_EXTRACTION"
    | "CONTEXT_SEARCH"
    | "PATCH_SYNTHESIS"
    | "PATCH_SYNTHESIS_COVERAGE"
    | "SANDBOX_VERIFY"
    | "SANDBOX_VERIFY_FAILED"
    | "PATCH_SYNTHESIS_FAILED"
    | "PATCH_OUTCOME"
    | "PATCH_QUALITY"
    | "SR_EDITS_PARSED"
    | "SR_VALIDATION_FAILED"
    | "INFO"
    | "ERROR"
    | "COMMAND_EXECUTED";
  data: any;
}

export class AgentLogger {
  private logFilePath: string;
  private turnId: string;
  private correlationId?: string;

  constructor(workspacePath: string) {
    const logDir = path.join(workspacePath, ".rei", "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    // These logs hold every prompt, decision and patch of the session, inside the user's repo.
    // The wizard ignores `.rei/` when it writes the .env; a hand-configured install never ran it,
    // and this is the other place the directory comes into existence.
    ensureReiDirIgnored(workspacePath);
    this.logFilePath = path.join(logDir, "agent-flow.jsonl");
    this.turnId = this.generateTurnId();
  }

  private generateTurnId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }

  public startTurn() {
    this.turnId = this.generateTurnId();
    this.correlationId = undefined;
  }

  public setCorrelationId(id: string) {
    this.correlationId = id;
  }

  /** The current turn's id (set by startTurn). Reused to stamp ChatMessages so the session
   *  correlates with this turn's agent-flow.jsonl entries. See docs/context-drift-spec.md. */
  public getTurnId(): string {
    return this.turnId;
  }

  private persistLogEntry(phase: LogEntry["phase"], data: any) {
    try {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        turnId: this.turnId,
        correlationId: this.correlationId,
        phase,
        data,
      };
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + "\n");
    } catch (e) {
      // Best effort logging, don't crash the agent if fs fails
    }
  }

  public logUserPrompt(data: { mode: string; prompt: string }) {
    this.persistLogEntry("USER_PROMPT", data);
  }

  public logDecision(rawOutput: string, parsed: any) {
    this.persistLogEntry("DECISION", { rawOutput, parsed });
  }

  public logKnowledge(
    provider: string,
    query: string,
    hits: number,
    urlContext: string,
  ) {
    this.persistLogEntry("KNOWLEDGE", { provider, query, hits, urlContext });
  }

  public logPatchProposal(file: string, patchText: string) {
    this.persistLogEntry("PATCH_PROPOSED", { file, patchText });
  }

  public logAstContext(
    filesScraped: number,
    dependenciesFound: number,
    signatureLength: number,
  ) {
    this.persistLogEntry("AST_CONTEXT_EXTRACTION", {
      filesScraped,
      dependenciesFound,
      signatureLength,
    });
  }

  public logContextSearch(
    query: string,
    hits: Array<{
      filePath: string;
      nodeType: string;
      nodeName: string;
      score: number;
    }>,
  ) {
    this.persistLogEntry("CONTEXT_SEARCH", { query, hitsCount: hits.length, hits });
  }

  public logCriticLoop(file: string, errors: string[]) {
    this.persistLogEntry("AST_CRITIC_LOOP", { file, errors });
  }

  public logPatchSynthesis(editCount: number, patchCount: number) {
    this.persistLogEntry("PATCH_SYNTHESIS", { editCount, patchCount });
  }

  public logPatchSynthesisCoverage(data: {
    rawEditCount: number;
    acceptedEditCount: number;
    patchCount: number;
    droppedEdits: Array<{
      file: string;
      description: string;
      reason: string;
      detail?: string;
    }>;
  }) {
    this.persistLogEntry("PATCH_SYNTHESIS_COVERAGE", data);
  }

  public logSandboxVerify(data: {
    command: string;
    patchCount: number;
    verified: boolean;
    exitCode: number;
    stdoutPreview?: string;
    stderrPreview?: string;
  }) {
    this.persistLogEntry("SANDBOX_VERIFY", data);
  }

  public logSandboxVerifyFailed(data: {
    command: string;
    patchCount: number;
    reason: string;
    details?: string;
  }) {
    this.persistLogEntry("SANDBOX_VERIFY_FAILED", data);
  }

  public logSynthesisFailed(reason: string, details?: string) {
    this.persistLogEntry("PATCH_SYNTHESIS_FAILED", { reason, details });
  }

  public logPatchOutcome(data: {
    validCount: number;
    rejectedCount: number;
    sandboxVerified: boolean;
    confirmableCount: number;
  }) {
    this.persistLogEntry("PATCH_OUTCOME", data);
  }

  public logPatchQuality(data: {
    ideaDetected: boolean;
    patchGenerated: boolean;
    patchApplicable: boolean;
    patchCompilable: boolean;
    generatedPatchCount: number;
    appliedPatchCount: number;
  }) {
    this.persistLogEntry("PATCH_QUALITY", data);
  }

  public logSREditsParsed(data: {
    turnLoop: number;
    count: number;
    files: string[];
    previews: Array<{
      file: string;
      searchLines: number;
      replaceLines: number;
      searchPreview: string;
      replacePreview: string;
    }>;
  }) {
    this.persistLogEntry("SR_EDITS_PARSED", data);
  }

  public logSRValidationFailed(data: {
    turnLoop: number;
    errorKind: "apply" | "compile" | "mixed";
    editCount: number;
    files: string[];
    applyErrors: string[];
    diagnostics: Array<{
      filePath: string;
      line: number;
      column: number;
      code: number | string;
      message: string;
    }>;
  }) {
    this.persistLogEntry("SR_VALIDATION_FAILED", data);
  }

  public logInfo(message: string, context?: any) {
    this.persistLogEntry("INFO", { message, context });
  }

  public logNoEditsReason(reason: string, context?: any) {
    this.logInfo("No edits produced", { reason, context });
  }

  public logError(message: string, stack?: string) {
    this.persistLogEntry("ERROR", { message, stack });
  }

  public logCommandExecution(command: string, result: any) {
    this.persistLogEntry("COMMAND_EXECUTED", { command, ...result });
  }
}
