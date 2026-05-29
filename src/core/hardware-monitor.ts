import * as os from "os";

export interface OllamaModelStatus {
  name: string;
  sizeBytes: number;
  vramBytes: number;
  ramBytes: number;       // bytes spilled to system RAM
  isFullyInVram: boolean;
  isPartiallyInRam: boolean;
}

export interface HardwareStatus {
  ramFreeMb: number;
  ramTotalMb: number;
  ramFreePercent: number;
  models: OllamaModelStatus[];
  /** Formatted warning strings ready to display to the user. */
  warnings: string[];
  /** True when Ollama is reachable. */
  ollamaReachable: boolean;
}

const MB = 1_048_576;
const LOW_RAM_THRESHOLD_MB = 1500;
const CRITICAL_RAM_THRESHOLD_MB = 500;

/**
 * Queries Ollama /api/ps and checks system RAM.
 * Non-blocking — all errors are caught and result in empty status.
 * Only meaningful when MODEL_PROVIDER=ollama or AGENT_MODEL_PROVIDER=ollama.
 */
export async function checkHardware(params: {
  ollamaBaseUrl?: string;
  targetModel?: string;
}): Promise<HardwareStatus> {
  const baseUrl = (params.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434")
    .replace(/\/+$/, "");

  const ramFreeMb = Math.round(os.freemem() / MB);
  const ramTotalMb = Math.round(os.totalmem() / MB);
  const ramFreePercent = Math.round((ramFreeMb / ramTotalMb) * 100);

  const warnings: string[] = [];
  let models: OllamaModelStatus[] = [];
  let ollamaReachable = false;

  // ── System RAM check ────────────────────────────────────────────────────
  if (ramFreeMb < CRITICAL_RAM_THRESHOLD_MB) {
    warnings.push(
      `\x1b[31m⚠️  [HW] Critical: only ${ramFreeMb}MB RAM free. ` +
      `REI may crash or produce very slow responses.\x1b[0m`,
    );
  } else if (ramFreeMb < LOW_RAM_THRESHOLD_MB) {
    warnings.push(
      `\x1b[33m⚠️  [HW] Low RAM: ${ramFreeMb}MB free of ${ramTotalMb}MB. ` +
      `Consider closing other apps.\x1b[0m`,
    );
  }

  // ── Ollama model status ──────────────────────────────────────────────────
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000); // 2s timeout
    const resp = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal });
    clearTimeout(timeout);

    if (resp.ok) {
      ollamaReachable = true;
      const data = await resp.json() as {
        models?: Array<{
          name?: string;
          size?: number;
          size_vram?: number;
        }>;
      };

      models = (data.models ?? []).map((m) => {
        const sizeBytes = m.size ?? 0;
        const vramBytes = m.size_vram ?? 0;
        const ramBytes = Math.max(0, sizeBytes - vramBytes);
        const isPartiallyInRam = ramBytes > 0 && vramBytes > 0;
        const isFullyInVram = vramBytes >= sizeBytes && sizeBytes > 0;

        return {
          name: m.name ?? "unknown",
          sizeBytes,
          vramBytes,
          ramBytes,
          isFullyInVram,
          isPartiallyInRam,
        };
      });

      // Check if target model is loaded and warn about RAM spillage
      const target = params.targetModel;
      if (target) {
        const loaded = models.find((m) =>
          m.name === target || m.name.startsWith(target.split(":")[0]),
        );

        if (!loaded) {
          // Model not loaded — cold start expected (no warning, just informational)
        } else if (loaded.isPartiallyInRam) {
          const ramMb = Math.round(loaded.ramBytes / MB);
          const vramMb = Math.round(loaded.vramBytes / MB);
          warnings.push(
            `\x1b[33m⚠️  [HW] Model "${loaded.name}" is split: ` +
            `${vramMb}MB in VRAM + ${ramMb}MB in RAM. ` +
            `Inference will be slow. ` +
            `Try a smaller model or increase OLLAMA_NUM_GPU_LAYERS.\x1b[0m`,
          );
        }
      }
    }
  } catch {
    // Ollama unreachable or timed out — not an error for non-Ollama providers
  }

  return { ramFreeMb, ramTotalMb, ramFreePercent, models, warnings, ollamaReachable };
}

/**
 * Returns true only when the active provider is Ollama (ask/planning or agent).
 */
export function isOllamaProvider(mode?: string): boolean {
  const isAgent = mode === "agent";
  const agentProv = process.env.AGENT_MODEL_PROVIDER?.trim().toLowerCase();
  const mainProv = process.env.MODEL_PROVIDER?.trim().toLowerCase();
  return isAgent ? agentProv === "ollama" : mainProv === "ollama";
}

/**
 * Returns the model name to check for the given mode.
 */
export function resolveModelNameForHardwareCheck(mode?: string): string | undefined {
  const isAgent = mode === "agent";
  if (isAgent) {
    return process.env.OLLAMA_MODEL_AGENT?.trim() ?? process.env.OLLAMA_MODEL?.trim();
  }
  const modeKey = mode ? `OLLAMA_MODEL_${mode.toUpperCase()}` : undefined;
  return (modeKey ? process.env[modeKey]?.trim() : undefined) ?? process.env.OLLAMA_MODEL?.trim();
}
