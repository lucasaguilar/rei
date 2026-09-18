/**
 * Provider keys, and the old spellings that still have to resolve.
 *
 * LM Studio's key was written `llmstudio` for most of REI's life — a typo that leaked into every
 * `.env` (`MODEL_PROVIDER=`), every `rei.config.json` (`providers.<key>`) and the wizard's model
 * table. Renaming it to `lmstudio` without this layer would greet an existing install with
 * `Unknown MODEL_PROVIDER: llmstudio` and — worse, because it fails silently — a per-model tuning
 * block that simply stops being found.
 *
 * So the name is normalised at the three boundaries where it arrives from outside (env, config
 * file, `/provider`) and nowhere else: inside REI there is one spelling.
 *
 * Note the env-var PREFIX is untouched: `LLM_STUDIO_MODEL` and friends are mapped explicitly in
 * `provider-factory.ts` and were never part of this typo.
 */

/** Old or plausible spellings → the canonical key. */
const PROVIDER_ALIASES: Record<string, string> = {
  llmstudio: "lmstudio",
  "lm-studio": "lmstudio",
  lm_studio: "lmstudio",
  "lm studio": "lmstudio",
};

/** The canonical key for whatever the user wrote. Unknown names pass through untouched, so the
 *  caller still gets to produce its own "unknown provider" error. */
export function normalizeProviderName(name: string): string {
  const key = name.trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? key;
}

/**
 * Re-keys a `providers` map from `rei.config.json` onto canonical names, so a config written
 * against the old spelling keeps tuning the same provider. A config carrying BOTH spellings keeps
 * the canonical one — it is the deliberate entry.
 */
export function normalizeProviderKeys<T>(providers: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(providers)) {
    const canonical = normalizeProviderName(key);
    // An alias never overwrites an entry already written under the canonical name.
    if (canonical !== key && out[canonical] !== undefined) continue;
    out[canonical] = value;
  }
  return out;
}
