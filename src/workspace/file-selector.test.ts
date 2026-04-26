import { describe, it, expect } from "vitest";
import { 
  extractExplicitPathHints, 
  selectRelevantFiles, 
  type RankedFile 
} from "./file-selector.js";
import type { FileMeta } from "./workspace-scanner.js";

describe("file-selector", () => {
  
  describe("extractExplicitPathHints", () => {
    it("should extract paths with a directory prefix", () => {
      const input = "mira mi archivo src/core/agent.ts por favor";
      const hints = extractExplicitPathHints(input);
      expect(hints).toEqual(["src/core/agent.ts"]);
    });

    it("should extract standalone filenames without a directory prefix", () => {
      const input = "modifica agent.ts y utils.js";
      const hints = extractExplicitPathHints(input);
      expect(hints).toContain("agent.ts");
      expect(hints).toContain("utils.js");
    });

    it("should extract multiple paths", () => {
      const input = "change src/workspace/file-selector.ts and package.json";
      const hints = extractExplicitPathHints(input);
      expect(hints).toContain("src/workspace/file-selector.ts");
      expect(hints).toContain("package.json");
    });

    it("should handle mixed case and convert to lowercase", () => {
      const input = "Can you look at README.md?";
      const hints = extractExplicitPathHints(input);
      expect(hints).toContain("readme.md");
    });

    it("should return empty array if no files mentioned", () => {
      const input = "cómo hago un componente en angular?";
      const hints = extractExplicitPathHints(input);
      expect(hints).toEqual([]);
    });
  });

  describe("selectRelevantFiles", () => {
    const mockFiles: FileMeta[] = [
      { path: "src/core/agent.ts", name: "agent.ts", extension: "ts" },
      { path: "src/workspace/file-selector.ts", name: "file-selector.ts", extension: "ts" },
      { path: "src/utils/math.ts", name: "math.ts", extension: "ts" },
      { path: "package.json", name: "package.json", extension: "json" },
      { path: "README.md", name: "README.md", extension: "md" }
    ];

    it("should highly rank files explicitly mentioned by full path", () => {
      const input = "revisa src/core/agent.ts";
      const result = selectRelevantFiles(mockFiles, input, "agent");
      
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe("agent.ts");
      // Exact paths get +30 score
      expect(result[0].score).toBeGreaterThanOrEqual(30);
    });

    it("should correctly rank files mentioned by filename only", () => {
      const input = "revisa agent.ts";
      const result = selectRelevantFiles(mockFiles, input, "agent");
      
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe("agent.ts");
      // Partial paths (endsWith) get +12 score, plus keyword matches
      expect(result[0].score).toBeGreaterThanOrEqual(12);
    });

    it("should ignore stopwords in Spanish and English when scoring", () => {
      // "the", "file", "el", "archivo", "modifica" are stopwords and shouldn't boost random files
      const input = "modifica the file el archivo";
      const result = selectRelevantFiles(mockFiles, input, "agent");
      
      // Since mode is agent, source files get a default +1 score boost
      // but no specific file should get a massive boost from these stopwords.
      const agentFile = result.find(f => f.name === "agent.ts");
      expect(agentFile?.score).toBe(1); // Only the source file +1 boost
    });

    it("should apply mode-specific boosts (planning prefers docs)", () => {
      const input = "haz un plan para la arquitectura";
      const result = selectRelevantFiles(mockFiles, input, "planning");
      
      const readme = result.find(f => f.name === "README.md");
      const packageJson = result.find(f => f.name === "package.json");
      
      // In planning mode, README and package.json get +2 score
      expect(readme?.score).toBeGreaterThanOrEqual(2);
      expect(packageJson?.score).toBeGreaterThanOrEqual(2);
    });

    it("should rank files based on keyword matches in name and path", () => {
      const input = "necesito usar math utils";
      const result = selectRelevantFiles(mockFiles, input, "agent");
      
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe("math.ts"); // "math" in name (+3) and path (+1)
    });
    
    it("should use fallback scoring in ask mode if no keywords match", () => {
      const input = "cómo funciona esto?";
      const result = selectRelevantFiles(mockFiles, input, "ask");
      
      expect(result.length).toBeGreaterThan(0);
      // Fallback prioritizes src/ (+6) and source extensions (+4)
      const topFile = result[0];
      expect(topFile.path.startsWith("src/")).toBe(true);
      expect(topFile.extension).toBe("ts");
    });
  });

});
