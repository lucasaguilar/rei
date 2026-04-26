import { describe, it, expect } from "vitest";
import { applySearchReplace, applyFileEdits } from "./search-replace.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";

describe("search-replace", () => {
  describe("applySearchReplace", () => {
    it("should correctly replace an exact string match", () => {
      const content = `function add(a, b) {\n  return a + b;\n}`;
      const edit: AgentSREdit = {
        file: "math.ts",
        search: `  return a + b;`,
        replace: `  return a + b + 0;`
      };

      const result = applySearchReplace(content, edit);
      expect(result.success).toBe(true);
      expect(result.newContent).toContain("return a + b + 0;");
      expect(result.error).toBeUndefined();
    });

    it("should normalize windows line endings before matching", () => {
      const content = `const a = 1;\r\nconst b = 2;`;
      const edit: AgentSREdit = {
        file: "vars.ts",
        search: `const a = 1;\nconst b = 2;`,
        replace: `const a = 2;\nconst b = 3;`
      };

      const result = applySearchReplace(content, edit);
      expect(result.success).toBe(true);
      expect(result.newContent).toBe(`const a = 2;\nconst b = 3;`);
    });

    it("should fail gracefully if the exact string is not found", () => {
      const content = `function doSomething() {}`;
      const edit: AgentSREdit = {
        file: "index.ts",
        search: `function doOtherThing() {}`,
        replace: `function doSomethingElse() {}`
      };

      const result = applySearchReplace(content, edit);
      expect(result.success).toBe(false);
      expect(result.newContent).toBeUndefined();
      expect(result.error).toContain("Could not find exact match for search block");
    });

    it("should fail gracefully if the search block matches multiple locations", () => {
      const content = `let a = 1;\nlet b = 1;\nlet c = 1;`;
      const edit: AgentSREdit = {
        file: "index.ts",
        search: `let b = 1;`,
        replace: `let b = 2;`
      };
      
      // We will make the search string non-unique
      edit.search = ` = 1;`;
      edit.replace = ` = 2;`;

      const result = applySearchReplace(content, edit);
      expect(result.success).toBe(false);
      expect(result.error).toContain("matched multiple locations");
    });
  });

  describe("applyFileEdits", () => {
    it("should sequentially apply multiple edits to the same file", () => {
      const content = `let a = 1;\nlet b = 2;`;
      const edits: AgentSREdit[] = [
        { file: "index.ts", search: `let a = 1;`, replace: `let a = 10;` },
        { file: "index.ts", search: `let b = 2;`, replace: `let b = 20;` }
      ];

      const result = applyFileEdits(content, edits);
      expect(result.success).toBe(true);
      expect(result.newContent).toBe(`let a = 10;\nlet b = 20;`);
    });

    it("should fail fast if any edit in the sequence fails", () => {
      const content = `let a = 1;\nlet b = 2;`;
      const edits: AgentSREdit[] = [
        { file: "index.ts", search: `let a = 1;`, replace: `let a = 10;` },
        { file: "index.ts", search: `let c = 3;`, replace: `let c = 30;` } // This will fail
      ];

      const result = applyFileEdits(content, edits);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not find exact match");
    });
  });
});
