import * as fs from "fs";
import * as path from "path";

export interface LogEntry {
  timestamp: string;
  turnId: string;
  phase:
    | "DECISION"
    | "KNOWLEDGE"
    | "PATCH_PROPOSED"
    | "AST_CRITIC_LOOP"
    | "AST_CONTEXT_EXTRACTION"
    | "RAG_SEARCH"
    | "PATCH_SYNTHESIS"
    | "PATCH_SYNTHESIS_COVERAGE"
    | "SANDBOX_VERIFY"
    | "SANDBOX_VERIFY_FAILED"
    | "PATCH_SYNTHESIS_FAILED"
    | "ERROR";
  data: any;
}

export class AgentLogger {
  private logFilePath: string;
  private turnId: string;

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
  }

  private write(phase: LogEntry["phase"], data: any) {
    try {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        turnId: this.turnId,
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

  public logRagSearch(
    query: string,
    hits: Array<{
      filePath: string;
      nodeType: string;
      nodeName: string;
      score: number;
    }>,
  ) {
    this.write("RAG_SEARCH", { query, hitsCount: hits.length, hits });
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

  public logError(message: string, stack?: string) {
    this.write("ERROR", { message, stack });
  }
}
