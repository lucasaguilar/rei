/**
 * Whether the semantic RAG vector index is enabled.
 *
 * OFF by default: building it on repo entry is heavy (embeds every file + pulls the `sharp`
 * native addon) and it goes UNUSED in on-demand file-context modes (ask/planning always, and
 * agent when REI_ON_DEMAND_FILE_CONTEXT_AGENT=1) — those discover code via tools, not proactive
 * injection. So a fresh repo starts lighter with no background indexing.
 *
 * Opt IN with `REI_ENABLE_RAG=1` (only worth it for proactive agent mode that wants semantic
 * file selection). The legacy `REI_SKIP_RAG` still forces it OFF and takes precedence, so
 * existing configs keep working unchanged.
 *
 * Note: this gates only the automatic BUILD. Using an index that already exists on disk is
 * gated separately by `hasRagIndex()`, so a manual `/index` still builds + queries fine.
 */
export function isRagEnabled(): boolean {
  if (process.env.REI_SKIP_RAG) return false;
  return process.env.REI_ENABLE_RAG === "1";
}
