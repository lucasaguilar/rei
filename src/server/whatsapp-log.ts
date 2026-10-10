/**
 * One line per WhatsApp event, on stdout/stderr — which is also what Render shows under Logs.
 *
 * Written for the moment something does not happen: you wrote from your phone and got nothing
 * back. Every place a message can stop (bad signature, allowlist, duplicate, non-text, slash
 * command, a failed turn, a Graph API error) says so here, with the reason.
 *
 * Privacy: hosted logs are kept by the platform, so phone numbers are masked to their last 4
 * digits and message text is NOT logged unless REI_WHATSAPP_LOG_BODY=true (meant for local
 * debugging).
 */

export function waLog(line: string): void {
  console.log(`[whatsapp] ${line}`);
}

export function waError(line: string): void {
  console.error(`[whatsapp] ${line}`);
}

/** `5491100001234` → `…1234`: enough to tell senders apart, not enough to identify one. */
export function maskNumber(n: string): string {
  return `…${(n ?? "").slice(-4)}`;
}

const BODY_PREVIEW_CHARS = 80;

/** `12 chars`, or `12 chars: "…"` when message text logging is switched on. */
export function describeBody(body: string): string {
  const size = `${body.length} chars`;
  if (process.env.REI_WHATSAPP_LOG_BODY !== "true") return size;
  const preview =
    body.length > BODY_PREVIEW_CHARS ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body;
  return `${size}: ${JSON.stringify(preview)}`;
}
