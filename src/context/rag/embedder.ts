import { pipeline, env, FeatureExtractionPipeline } from "@xenova/transformers";
import { fetchWithRetry } from "../../providers/fetch-retry.js";

// Allow the model to be downloaded on first use (Xenova fetches it from the hub).
env.allowRemoteModels = true;

const XENOVA_DEFAULT_MODEL = "Xenova/multilingual-e5-small";

// The embedder is now PARAMETRIZABLE. The default is the in-process Xenova MiniLM (zero-config,
// English-centric, 384-dim). For multilingual docs (Spanish, etc.) point it at a server model
// via REI_EMBEDDER_PROVIDER=lmstudio (OpenAI-compatible /v1/embeddings, e.g. bge-m3). Indexing
// and querying MUST use the same embedder — getEmbedderId() is stamped into the index so a
// change triggers a reindex (different models emit different dims → vector spaces don't align).

function embedderProvider(): string {
  return (process.env.REI_EMBEDDER_PROVIDER ?? "xenova").trim().toLowerCase();
}

function embedderModel(): string {
  const p = embedderProvider();
  if (p === "xenova") return process.env.REI_EMBEDDER_MODEL || XENOVA_DEFAULT_MODEL;
  return process.env.REI_EMBEDDER_MODEL || "";
}

/** e5 models (intfloat/multilingual-e5-*, e5-*) are TRAINED with "query: " / "passage: " input
 *  prefixes — using them is required for good retrieval. Other models (MiniLM, bge-m3, …) must NOT
 *  be prefixed, so this is gated on the model name. */
function isE5Model(): boolean {
  return /e5-/i.test(embedderModel());
}

/** Prepends the e5 retrieval prefix for the given input role (no-op for non-e5 models). */
function applyEmbedPrefix(text: string, kind: "query" | "passage"): string {
  return isE5Model() ? `${kind}: ${text}` : text;
}

/** Stable identity for the active embedder. Stamped into the index to invalidate it on change.
 *  The `+e5p` marker means the index was built WITH e5 prefixes, so toggling e5 (or the prefixing)
 *  forces a reindex — querying a no-prefix index with prefixed queries (or vice-versa) misaligns. */
export function getEmbedderId(): string {
  const base = `${embedderProvider()}:${embedderModel()}`;
  return isE5Model() ? `${base}+e5p` : base;
}

// ── Xenova (in-process ONNX) ──────────────────────────────────────────────
let xenovaPipeline: FeatureExtractionPipeline | null = null;
async function getXenova(): Promise<FeatureExtractionPipeline> {
  if (!xenovaPipeline) {
    // First run downloads ~22MB quantized weights into node's cache.
    xenovaPipeline = await pipeline("feature-extraction", embedderModel(), {
      quantized: true,
    });
  }
  return xenovaPipeline;
}
async function embedXenova(text: string): Promise<number[]> {
  const extractor = await getXenova();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

// ── OpenAI-compatible /v1/embeddings (LM Studio, OpenAI, cloud) ────────────
async function embedOpenAICompatible(text: string): Promise<number[]> {
  const baseUrl = (
    process.env.REI_EMBEDDER_BASE_URL ||
    process.env.LLM_STUDIO_BASE_URL ||
    "http://127.0.0.1:1234/v1"
  ).replace(/\/+$/, "");
  const apiKey =
    process.env.REI_EMBEDDER_API_KEY || process.env.LLM_STUDIO_API_KEY || "lm-studio";
  const model = embedderModel();
  if (!model) throw new Error("REI_EMBEDDER_MODEL is required for a server embedder.");

  const res = await fetchWithRetry(
    `${baseUrl}/embeddings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: text }),
    },
    { timeoutMs: 60_000 },
  );
  if (!res.ok) {
    const details = await res.text().catch(() => "");
    throw new Error(
      `Embedder request failed (${res.status} ${res.statusText})` +
        (details ? `: ${details.slice(0, 200)}` : ""),
    );
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("Embedder returned no embedding.");
  return vec;
}

// ── Ollama /api/embeddings ─────────────────────────────────────────────────
async function embedOllama(text: string): Promise<number[]> {
  const baseUrl = (
    process.env.REI_EMBEDDER_BASE_URL ||
    process.env.OLLAMA_BASE_URL ||
    "http://127.0.0.1:11434"
  ).replace(/\/+$/, "");
  const model = embedderModel();
  if (!model) throw new Error("REI_EMBEDDER_MODEL is required for the ollama embedder.");

  const res = await fetchWithRetry(
    `${baseUrl}/api/embeddings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    },
    { timeoutMs: 60_000 },
  );
  if (!res.ok) throw new Error(`Ollama embedder failed (${res.status} ${res.statusText})`);
  const json = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(json.embedding)) throw new Error("Ollama returned no embedding.");
  return json.embedding;
}

/**
 * Genera un vector (Embedding) para un texto dado, usando el backend configurado.
 * @param kind  "passage" when embedding a document to index, "query" when embedding a search query.
 *              Only affects e5 models (which require the prefix); a no-op for others.
 * @returns Un arreglo de números Float (dim depende del modelo: MiniLM 384, bge-m3 1024, …).
 */
export async function generateEmbedding(
  text: string,
  kind: "query" | "passage" = "passage",
): Promise<number[]> {
  const input = applyEmbedPrefix(text, kind);
  switch (embedderProvider()) {
    case "ollama":
      return embedOllama(input);
    case "lmstudio":
    case "openai":
      return embedOpenAICompatible(input);
    case "xenova":
    default:
      return embedXenova(input);
  }
}
