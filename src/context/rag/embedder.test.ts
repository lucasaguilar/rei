import { describe, it, expect, afterEach, vi } from "vitest";
import { getEmbedderId, generateEmbedding } from "./embedder.js";

const KEYS = [
  "REI_EMBEDDER_PROVIDER",
  "REI_EMBEDDER_MODEL",
  "REI_EMBEDDER_BASE_URL",
  "REI_EMBEDDER_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("getEmbedderId", () => {
  it("defaults to the in-process Xenova multilingual-e5-small (with the e5-prefix marker)", () => {
    for (const k of KEYS) delete process.env[k];
    // The `+e5p` marker is part of the id so toggling e5 prefixing invalidates the index.
    expect(getEmbedderId()).toBe("xenova:Xenova/multilingual-e5-small+e5p");
  });

  it("reflects a configured server embedder (provider:model)", () => {
    process.env.REI_EMBEDDER_PROVIDER = "lmstudio";
    process.env.REI_EMBEDDER_MODEL = "bge-m3";
    expect(getEmbedderId()).toBe("lmstudio:bge-m3");
  });
});

describe("generateEmbedding — OpenAI-compatible backend (LM Studio)", () => {
  it("POSTs to /embeddings and returns the vector", async () => {
    process.env.REI_EMBEDDER_PROVIDER = "lmstudio";
    process.env.REI_EMBEDDER_MODEL = "bge-m3";
    process.env.REI_EMBEDDER_BASE_URL = "http://x/v1";

    let calledUrl = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (url: unknown, init: { body: string }) => {
      calledUrl = String(url);
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const vec = await generateEmbedding("hola mundo");
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(calledUrl).toBe("http://x/v1/embeddings");
    expect(body.model).toBe("bge-m3");
    expect(body.input).toBe("hola mundo");
  });

  it("throws when no model is configured for a server embedder", async () => {
    process.env.REI_EMBEDDER_PROVIDER = "lmstudio";
    delete process.env.REI_EMBEDDER_MODEL;
    await expect(generateEmbedding("x")).rejects.toThrow(/REI_EMBEDDER_MODEL/);
  });

  it("prefixes the input with query:/passage: for an e5 model (and only e5)", async () => {
    process.env.REI_EMBEDDER_PROVIDER = "lmstudio";
    process.env.REI_EMBEDDER_MODEL = "intfloat/multilingual-e5-small";
    process.env.REI_EMBEDDER_BASE_URL = "http://x/v1";

    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ embedding: [0] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await generateEmbedding("hola", "query");
    expect(body.input).toBe("query: hola");

    await generateEmbedding("mundo", "passage");
    expect(body.input).toBe("passage: mundo");

    // default kind is passage
    await generateEmbedding("default");
    expect(body.input).toBe("passage: default");
  });
});
