import * as fs from "fs";
import * as path from "path";

export interface LogEntry {
  timestamp: string;
  turnId: string;
  correlationId?: string;
  phase:
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
    | "ERROR";
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

  private write(phase: LogEntry["phase"], data: any) {
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

  public logDecision(rawOutput: string, parsed: any) {
    this.write("DECISION", { rawOutput, parsed });
  }

  public logKnowledge(
    provider: string,
    query: string,
    hits: number,
    urlContext: string,
  ) {
    this.write("KNOWLEDGE", { provider, query, hits, urlContext });
  }

  public logPatchProposal(file: string, patchText: string) {
    this.write("PATCH_PROPOSED", { file, patchText });
  }

  public logAstContext(
    filesScraped: number,
    dependenciesFound: number,
    signatureLength: number,
  ) {
    this.write("AST_CONTEXT_EXTRACTION", {
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
    this.write("CONTEXT_SEARCH", { query, hitsCount: hits.length, hits });
  }

  public logCriticLoop(file: string, errors: string[]) {
    this.write("AST_CRITIC_LOOP", { file, errors });
  }

  public logPatchSynthesis(editCount: number, patchCount: number) {
    this.write("PATCH_SYNTHESIS", { editCount, patchCount });
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
    this.write("PATCH_SYNTHESIS_COVERAGE", data);
  }

  public logSandboxVerify(data: {
    command: string;
    patchCount: number;
    verified: boolean;
    exitCode: number;
    stdoutPreview?: string;
    stderrPreview?: string;
  }) {
    this.write("SANDBOX_VERIFY", data);
  }

  public logSandboxVerifyFailed(data: {
    command: string;
    patchCount: number;
    reason: string;
    details?: string;
  }) {
    this.write("SANDBOX_VERIFY_FAILED", data);
  }

  public logSynthesisFailed(reason: string, details?: string) {
    this.write("PATCH_SYNTHESIS_FAILED", { reason, details });
  }

  public logPatchOutcome(data: {
    validCount: number;
    rejectedCount: number;
    sandboxVerified: boolean;
    confirmableCount: number;
  }) {
    this.write("PATCH_OUTCOME", data);
  }

  public logPatchQuality(data: {
    ideaDetected: boolean;
    patchGenerated: boolean;
    patchApplicable: boolean;
    patchCompilable: boolean;
    generatedPatchCount: number;
    appliedPatchCount: number;
  }) {
    this.write("PATCH_QUALITY", data);
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
    this.write("SR_EDITS_PARSED", data);
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
      code: number;
      message: string;
    }>;
  }) {
    this.write("SR_VALIDATION_FAILED", data);
  }

  public logInfo(message: string, context?: any) {
    this.write("INFO", { message, context });
  }

  public logNoEditsReason(reason: string, context?: any) {
    this.logInfo("No edits produced", { reason, context });
  }

  public logError(message: string, stack?: string) {
    this.write("ERROR", { message, stack });
  }
}
