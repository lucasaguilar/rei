export function sanitizeAgentJsonText(rawResponse: string): string {
  let candidate = rawResponse.trim();
  if (!candidate) return "";

  if (candidate.charCodeAt(0) === 0xfeff) {
    candidate = candidate.slice(1);
  }

  candidate = candidate
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1).trim();
  }

  return candidate;
}
