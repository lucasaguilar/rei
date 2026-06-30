import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VectorStore, type VectorMetadata } from "./vector-store.js";

function meta(id: string): VectorMetadata {
  return { id, filePath: "a.ts", nodeType: "function", nodeName: id, startLine: 1, endLine: 2 };
}

describe("VectorStore — embedder-aware index invalidation (real disk)", () => {
  let ws: string;
  const saved = {
    REI_EMBEDDER_PROVIDER: process.env.REI_EMBEDDER_PROVIDER,
    REI_EMBEDDER_MODEL: process.env.REI_EMBEDDER_MODEL,
  };

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-vs-test-"));
    fs.mkdirSync(path.join(ws, ".rei"), { recursive: true }); // avoid the async-mkdir race
    delete process.env.REI_EMBEDDER_PROVIDER;
    delete process.env.REI_EMBEDDER_MODEL;
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const indexFile = () => path.join(ws, ".rei", "rag-index.json");

  it("stamps the embedder id and roundtrips records", async () => {
    const s = new VectorStore(ws);
    s.upsert(meta("x"), [1, 0, 0]);
    await s.save();

    const onDisk = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    expect(onDisk.embedderId).toBe("xenova:Xenova/multilingual-e5-small");

    const s2 = new VectorStore(ws);
    await s2.load();
    expect(s2.getRecordCount()).toBe(1);
  });

  it("keeps a legacy bare-array index when the embedder is still the default", async () => {
    process.env.REI_EMBEDDER_MODEL = "Xenova/all-MiniLM-L6-v2";
    fs.writeFileSync(indexFile(), JSON.stringify([{ vector: [1, 0], metadata: meta("y") }]));
    const s = new VectorStore(ws);
    await s.load();
    expect(s.getRecordCount()).toBe(1);
  });

  it("clears the index when the embedder changed (dim mismatch → reindex)", async () => {
    const s = new VectorStore(ws);
    s.upsert(meta("z"), [1, 0, 0]);
    await s.save();

    // Switch embedder → the cached vectors are incompatible.
    process.env.REI_EMBEDDER_PROVIDER = "llmstudio";
    process.env.REI_EMBEDDER_MODEL = "bge-m3";

    const s2 = new VectorStore(ws);
    await s2.load();
    expect(s2.getRecordCount()).toBe(0);
  });
});
