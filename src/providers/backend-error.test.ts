import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { explainBackendError } from "./backend-error.js";

/**
 * A local backend answers a failed request with ITS error. For MLX that is a Python traceback from
 * inside `.lmstudio/extensions` — twenty lines that never mention the actual fix, which in both
 * cases below is a load-time setting in the backend, not anything REI sent.
 */
const METAL_OOM =
  'Error in iterating prediction stream: Exception: Encountered fatal exception in the backend ' +
  'scheduler: Traceback (most recent call last):\n  File ' +
  '"/Users/x/.lmstudio/extensions/backends/vendor/_amphibian/app-mlx-generate/lib/python3.11/' +
  'site-packages/mlx_lm/generate.py", line 1369, in _step\n    mx.async_eval(self._next_tokens)\n' +
  "RuntimeError: [metal::malloc] Resource limit (499000) exceeded.\n";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.REI_CONTEXT_WINDOW;
  process.env.REI_CONTEXT_WINDOW = "100352";
});
afterEach(() => {
  if (saved === undefined) delete process.env.REI_CONTEXT_WINDOW;
  else process.env.REI_CONTEXT_WINDOW = saved;
});

describe("out of GPU memory", () => {
  it("names the cause and the window REI actually uses", () => {
    const out = explainBackendError(METAL_OOM);
    expect(out).toContain("ran out of GPU memory");
    expect(out).toContain("100,352");
    expect(out).not.toContain("Traceback"); // the trace is replaced, not appended
  });

  it("groups digits the same way whatever locale the machine is set to", () => {
    // `toLocaleString()` renders "100.352" under es-AR — a different number to an English reader.
    expect(explainBackendError(METAL_OOM)).not.toContain("100.352");
  });

  it("skips the window advice when no window is configured", () => {
    process.env.REI_CONTEXT_WINDOW = "0";
    const out = explainBackendError(METAL_OOM);
    expect(out).toContain("ran out of GPU memory");
    expect(out).not.toContain("REI is configured for");
  });

  it("recognises the short form without a traceback", () => {
    expect(explainBackendError("[metal::malloc] Resource limit (499000) exceeded.")).toContain(
      "GPU memory",
    );
  });
});

describe("cancelled model load", () => {
  it("names the model and points at the swap that caused it", () => {
    const out = explainBackendError(
      'Failed to load model "qwen/qwen3.8-27b-reasoning-community". Error: Operation canceled.',
    );
    expect(out).toContain("qwen/qwen3.8-27b-reasoning-community");
    expect(out).toContain("evicting another model");
  });

  it("matches when the error arrives inside a raw JSON body, quotes escaped", () => {
    // How it actually reaches us: the response body, not a parsed message.
    const raw = JSON.stringify({
      error: { message: 'Failed to load model "some-model". Error: Operation canceled.' },
    });
    expect(explainBackendError(raw)).toContain("some-model");
  });

  it("accepts the British spelling too", () => {
    expect(
      explainBackendError('Failed to load model "m". Error: Operation cancelled.'),
    ).toContain("could not load");
  });
});

describe("everything else", () => {
  it("passes an unfamiliar error through untouched", () => {
    // Guessing at an unknown failure would replace a true message with a plausible wrong one.
    const raw = "some unfamiliar backend failure";
    expect(explainBackendError(raw)).toBe(raw);
  });

  it("does not claim memory trouble for an ordinary 404", () => {
    const raw = '{"error":{"message":"Model not found","code":404}}';
    expect(explainBackendError(raw)).toBe(raw);
  });
});

/**
 * Verbatim body from a `hola` that never reached the model: LM Studio answers 400 and the turn is
 * lost to a toggle in the backend's right-hand panel. The traceback names the draft model, so the
 * obvious move — try a different draft model — is the one that cannot work.
 */
const DRAFT = JSON.stringify({
  error:
    "Failed to load draft model. SpeculativeDecodingNotSupportedError: Speculative decoding is " +
    "not supported for batched MLX models.",
});

describe("a draft model that cannot be loaded", () => {
  it("points at the toggle, not at the draft model", () => {
    const out = explainBackendError(DRAFT);
    expect(out).toContain("Speculative Decoding OFF");
    expect(out).not.toContain("SpeculativeDecodingNotSupportedError");
  });

  it("says a batched model can never speculate, so no other draft model is worth trying", () => {
    expect(explainBackendError(DRAFT)).toContain("no draft model will work with it");
  });

  it("clears REI of the blame — the request never reached the model", () => {
    expect(explainBackendError(DRAFT)).toContain("Nothing REI sent caused this");
  });

  it("falls back to the tokenizer explanation when the backend does not say 'batched'", () => {
    const out = explainBackendError("Failed to load draft model: vocab size mismatch");
    expect(out).toContain("tokenizer");
    expect(out).not.toContain("BATCHED");
  });
});

describe("unknown failures are still passed through", () => {
  it("does not invent a cause for an error it does not recognise", () => {
    expect(explainBackendError("ECONNREFUSED 127.0.0.1:1234")).toBe("ECONNREFUSED 127.0.0.1:1234");
  });
});
