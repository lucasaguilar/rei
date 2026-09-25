/**
 * @fileoverview Masking secrets in command output before the model (or a log) ever sees them.
 *
 * `read_files` already refuses to serve `.env` and private keys unless REI_ALLOW_SENSITIVE_READS is
 * set. `run_command` had no such rule: `env` printed every variable in the process and `cat .env`
 * printed the file, in full. That output goes three places — the model's context, which in the
 * hybrid setup the README recommends means a third-party API; the turn's history, re-sent every
 * turn; and `.rei/logs/agent-flow.jsonl` on disk.
 *
 * So the value is replaced and the NAME is kept: the model still learns that `OPENROUTER_API_KEY` is
 * set, which is all it legitimately needs to reason about configuration.
 *
 * Deliberately NOT applied to `read_files`: an edit is built from the exact bytes that tool returned,
 * and a masked value written back would destroy the real one. There, refusing the whole file is the
 * right answer, and that is what already happens.
 *
 * This is defence in depth, not a boundary — a command can always encode its output (base64, a
 * different separator) and slip past. It stops the accident and the casual `env`, which is what was
 * actually happening.
 *
 * @module rei/tools/secret-masking
 */

/** What replaces a secret. Distinctive enough to grep for in a transcript. */
export const SECRET_MASK = "***REI-MASKED***";

/**
 * `NAME=value` / `"name": "value"` where the name ENDS in a secret word.
 *
 * Ending, not containing, so `KEYWORD=search` and `TOKENIZER=bpe` are left alone. The value stops at
 * whitespace or a closing quote/bracket, so JSON keeps its shape and the line stays readable.
 */
const NAMED_SECRET =
  /([A-Za-z0-9_.\-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))(["']?\s*[=:]\s*["']?)([^\s"',;)}\]]+)/gi;

/**
 * Token shapes worth masking with no name attached — they turn up bare in a `curl` error, a git
 * remote URL or a stack trace. Prefix plus a minimum length, so ordinary words never match.
 */
const BARE_TOKENS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}/g, // OpenAI, OpenRouter (sk-or-v1-…)
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bhf_[A-Za-z0-9]{16,}/g, // Hugging Face
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
];

/**
 * The single reader of REI_ALLOW_SENSITIVE_READS: one switch for "I meant to look at this", covering
 * both halves of the policy — the files `read_files` refuses and the values masked here.
 * `sensitiveReadsAllowed()` in agent-mode delegates to this, so the two cannot drift apart.
 */
export function sensitiveMaterialAllowed(): boolean {
  return process.env.REI_ALLOW_SENSITIVE_READS === "true";
}

/** Replaces secret-looking values in `text`. Returns it unchanged when masking is off. */
export function maskSecrets(text: string): string {
  if (!text || sensitiveMaterialAllowed()) return text;
  let out = text.replace(NAMED_SECRET, (_m, name, sep) => `${name}${sep}${SECRET_MASK}`);
  for (const re of BARE_TOKENS) out = out.replace(re, SECRET_MASK);
  return out;
}
