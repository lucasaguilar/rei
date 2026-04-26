import { describe, it, expect } from "vitest";
import { chunkRepoMapString } from "./map-chunker.js";

describe("map-chunker", () => {
  describe("chunkRepoMapString", () => {
    it("should extract chunks for each file block", () => {
      const mockContent = `
### REPOSITORY SKELETON MAP

// FILE: src/core/agent.ts
// Imports: src/workspace/scanner.ts, src/logger.ts
export class Agent {
  public run(): void;
}

// FILE: src/logger.ts
// Imports: none
export function log(msg: string): void;
      `;

      const chunks = chunkRepoMapString(mockContent);

      expect(chunks).toHaveLength(2);

      const agentChunk = chunks.find(c => c.metadata.filePath === "src/core/agent.ts");
      expect(agentChunk).toBeDefined();
      expect(agentChunk?.metadata.id).toBe("map:src/core/agent.ts");
      expect(agentChunk?.metadata.dependencies).toEqual(["src/workspace/scanner.ts", "src/logger.ts"]);
      expect(agentChunk?.content).toContain("export class Agent");

      const loggerChunk = chunks.find(c => c.metadata.filePath === "src/logger.ts");
      expect(loggerChunk).toBeDefined();
      // "none" is filtered out by the chunker implementation
      expect(loggerChunk?.metadata.dependencies).toEqual([]);
      expect(loggerChunk?.content).toContain("export function log");
    });

    it("should handle empty or malformed strings gracefully", () => {
      expect(chunkRepoMapString("")).toEqual([]);
      expect(chunkRepoMapString("just some random text without file markers")).toEqual([]);
    });

    it("should extract dependencies correctly even if spacing varies", () => {
      const mockContent = `
// FILE: some/path.ts
// Imports:  a.ts , b.ts,c.ts 
const a = 1;
      `;
      const chunks = chunkRepoMapString(mockContent);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].metadata.dependencies).toEqual(["a.ts", "b.ts", "c.ts"]);
    });
  });
});
