import * as fs from "fs";
import * as path from "path";

export interface LogEntry {
  timestamp: string;
  turnId: string;
  phase: "DECISION" | "KNOWLEDGE" | "PATCH_PROPOSED" | "AST_CRITIC_LOOP" | "AST_CONTEXT_EXTRACTION" | "RAG_SEARCH" | "ERROR";
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

  public logKnowledge(provider: string, query: string, hits: number, urlContext: string) {
    this.write("KNOWLEDGE", { provider, query, hits, urlContext });
  }

  public logPatchProposal(file: string, patchText: string) {
    this.write("PATCH_PROPOSED", { file, patchText });
  }

  public logAstContext(filesScraped: number, dependenciesFound: number, signatureLength: number) {
    this.write("AST_CONTEXT_EXTRACTION", { filesScraped, dependenciesFound, signatureLength });
  }

  public logRagSearch(query: string, hits: Array<{ filePath: string; nodeType: string; nodeName: string; score: number }>) {
    this.write("RAG_SEARCH", { query, hitsCount: hits.length, hits });
  }

  public logCriticLoop(file: string, errors: string[]) {
    this.write("AST_CRITIC_LOOP", { file, errors });
  }

  public logError(message: string, stack?: string) {
    this.write("ERROR", { message, stack });
  }
}
