import { getContextWindow } from "../config/model-runtime.js";

/**
 * Turns a local backend's raw failure into something the user can act on.
 *
 * LM Studio answers a failed request with the backend's own error — for MLX that means a twenty-line
 * Python traceback. Both of the failures below have one concrete cause and one concrete fix, and
 * neither is visible in the text the backend sends: the user sees a stack trace from a file inside
 * `.lmstudio/extensions` and no indication that the answer is "reload the model with less context".
 *
 * Only patterns with a KNOWN cause are translated. Anything else is passed through untouched —
 * guessing at an unfamiliar error would replace a true message with a plausible wrong one.
 */

/** MLX's Metal allocator refusing an allocation: the model does not fit as currently loaded. */
const METAL_OOM = /metal::malloc|Resource limit \(\d+\) exceeded|Insufficient Memory/i;

/** LM Studio aborting a just-in-time load — typically evicting one model to make room for another. */
// The quotes may arrive ESCAPED: the failure often reaches us as the raw JSON body, where the
// model name reads `\"qwen/...\"` rather than `"qwen/..."`.
const LOAD_CANCELLED =
  /Failed to load model \\?"([^"\\]+)\\?"[^]*?(?:Operation cancel?led)/i;

/** Locale-independent thousands separator: the message is English, and `toLocaleString()` would
 *  render "100.352" on a machine set to Spanish — a different number to an English reader. */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function explainBackendError(raw: string): string {
  const load = raw.match(LOAD_CANCELLED);
  if (load) {
    return (
      `The backend could not load "${load[1]}".\n` +
      `  It cancelled the load, which usually means it was evicting another model to make room and ` +
      `the new one did not fit.\n` +
      `  • Running one model per mode makes the backend swap on every mode change — set the same ` +
      `model for ask/planning/agent, or raise the backend's max loaded models.\n` +
      `  • A model loaded with a very large context leaves no room for the next one.`
    );
  }

  if (METAL_OOM.test(raw)) {
    const window = getContextWindow();
    return (
      `The backend ran out of GPU memory while generating.\n` +
      (window > 0
        ? `  REI is configured for a ${groupDigits(window)}-token window. If the model is loaded ` +
          `with a LARGER context than that, the extra KV cache is reserved and never used — reload ` +
          `it at ${groupDigits(window)} in the backend.\n`
        : "") +
      `  • Check the loaded context length in the backend; it is set at load time, not per request.\n` +
      `  • Unload any other model sharing the GPU.\n` +
      `  • Lowering maxTokens in rei.config.json frees the output reservation too.`
    );
  }

  return raw;
}
