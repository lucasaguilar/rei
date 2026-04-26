import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorStore, type VectorMetadata } from "./vector-store.js";

// Mock the file system to avoid actual disk writes during testing
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn()
  }
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn()
}));

describe("VectorStore", () => {
  let store: VectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new VectorStore("/mock/workspace");
  });

  describe("upsert and deleteByFilePath", () => {
    it("should insert new records", () => {
      const meta: VectorMetadata = {
        id: "func:test",
        filePath: "src/test.ts",
        nodeType: "function",
        nodeName: "test",
        startLine: 1,
        endLine: 5
      };
      
      store.upsert(meta, [0.1, 0.2, 0.3]);
      expect(store.getRecordCount()).toBe(1);
    });

    it("should update existing records with the same id", () => {
      const meta: VectorMetadata = {
        id: "func:test",
        filePath: "src/test.ts",
        nodeType: "function",
        nodeName: "test",
        startLine: 1,
        endLine: 5
      };
      
      store.upsert(meta, [0.1, 0.2, 0.3]);
      store.upsert(meta, [0.4, 0.5, 0.6]); // Same ID, new vector
      
      expect(store.getRecordCount()).toBe(1);
      
      // Query with the new vector should return score ~1.0
      const results = store.query([0.4, 0.5, 0.6], 1);
      expect(results[0].score).toBeGreaterThan(0.99);
    });

    it("should delete records by file path", () => {
      store.upsert({ id: "func:a", filePath: "src/a.ts", nodeType: "function", nodeName: "a", startLine: 1, endLine: 2 }, [1, 0]);
      store.upsert({ id: "func:b", filePath: "src/b.ts", nodeType: "function", nodeName: "b", startLine: 1, endLine: 2 }, [0, 1]);
      
      expect(store.getRecordCount()).toBe(2);
      
      store.deleteByFilePath("src/a.ts");
      expect(store.getRecordCount()).toBe(1);
      
      // Only src/b.ts should remain
      const remaining = store.query([0, 1], 1);
      expect(remaining[0].metadata.filePath).toBe("src/b.ts");
    });
  });

  describe("query (Cosine Similarity)", () => {
    it("should rank similar vectors higher", () => {
      store.upsert({ id: "1", filePath: "a.ts", nodeType: "f", nodeName: "f", startLine: 1, endLine: 1 }, [1, 0, 0]);
      store.upsert({ id: "2", filePath: "b.ts", nodeType: "f", nodeName: "f", startLine: 1, endLine: 1 }, [0, 1, 0]);
      
      // Query vector perfectly matches ID "1"
      const results = store.query([1, 0, 0], 2);
      
      expect(results[0].metadata.id).toBe("1");
      expect(results[0].score).toBe(1); // 1.0 = perfect match
      
      expect(results[1].metadata.id).toBe("2");
      expect(results[1].score).toBe(0); // Orthogonal vectors
    });

    it("should handle zero magnitude vectors gracefully", () => {
      store.upsert({ id: "1", filePath: "a.ts", nodeType: "f", nodeName: "f", startLine: 1, endLine: 1 }, [0, 0]);
      
      const results = store.query([0, 0], 1);
      expect(results[0].score).toBe(0);
    });
  });
});
