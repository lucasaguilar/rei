# Plan: REI on Render + WhatsApp (Meta Cloud API) webhook

Status: planned 2026-09-25, not started. Written to be picked up in a separate worktree.

## Base branch

Branch the worktree from `fix/write-containment-and-secrets` (or from `main` once it is merged).
That branch holds the server hardening this plan relies on and that `main` does not have yet:
`src/server/browser-guard.ts`, token enforcement when `REI_SERVER_HOST` is public, and
`src/server/health.ts` (`/healthz` before auth).

## What the server exposes today (verified in `src/server.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/chat/completions` (`/v1/...` too) | Bearer if `REI_SERVER_TOKEN` | OpenAI-compatible, always SSE |
| GET | `/models` (`/v1/...` too) | Bearer if token | model list for IDE clients |
| GET | `/healthz` | none | liveness, `{"status":"ok"}` |
| OPTIONS | any | — | CORS preflight, 204 |

Anything else → 404. Paths go through `normalizeRoutePath` (drops query, trailing `/`, `/v1`).

## Why Meta cannot call REI directly

1. **Verification handshake**: Meta sends `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
   and expects the challenge echoed as plain text. REI answers 404/401.
2. **Payload shape**: `entry[].changes[].value.messages[]`, not `{messages:[{role,content}]}`;
   `ChatHandler.handleChatStream` would throw "No prompt provided."
3. **Auth**: Meta sends `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret),
   never a Bearer token. A public deploy requires `REI_SERVER_TOKEN`, so Meta gets 401.
4. **Reply channel**: Meta wants a fast 200; the reply is a separate
   `POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/messages`.
5. (Tunnels only, not Render) bound to loopback, a tunnel's `Host` header is rejected by
   `browser-guard.ts` as DNS rebinding. On Render the server binds `0.0.0.0`, so this does not apply.

## Step 1 — Fix the Docker image (blocker, do first)

The runtime stage of `Dockerfile` copies only `dist/`, `node_modules/`, `package.json`. But
`src/prompts/loader.ts:9`, `src/skills/skill-loader.ts:38` and `src/skills/role-loader.ts:31`
resolve `<root>/prompts` at runtime → `/app/prompts` is missing → the first chat turn fails while
`/healthz` stays green. Add to the runner stage:

```dockerfile
COPY --chown=node:node --from=builder /app/prompts ./prompts
```

Verify with a real `docker build` + `docker run` + one `curl` to `/chat/completions`.

## Step 2 — WhatsApp route

New module(s) under `src/server/` (keep `server.ts` under 400 lines; it is at 279), e.g.
`src/server/whatsapp-webhook.ts` + `src/server/whatsapp-webhook.test.ts`. Route: `/webhooks/whatsapp`.

- **GET**: `hub.mode === "subscribe"` and `hub.verify_token === WHATSAPP_VERIFY_TOKEN` → 200 with
  `hub.challenge` as `text/plain`; else 403.
- **POST**:
  - Read the RAW body; verify `X-Hub-Signature-256` = `sha256=` + HMAC(`WHATSAPP_APP_SECRET`, raw)
    with `timingSafeEqual`. Mismatch → 401.
  - Answer 200 immediately, then process asynchronously (Meta retries slow/failed deliveries).
  - Ignore non-message events (`statuses`), non-text messages for now (reply with a short notice).
  - Dedupe by message `id` (Meta retries → duplicate turns).
  - Run the turn, collect the full reply text, send via Graph API with `WHATSAPP_ACCESS_TOKEN`.
    WhatsApp text limit is 4096 chars → split longer replies.
- **Auth ordering in `server.ts`**: this route bypasses the Bearer check (like `/healthz`), because
  the HMAC signature is its auth. It must still be behind the signature check — never unauthenticated.
- Tests first (AGENTS.md): verification handshake, bad signature → 401, good signature → 200,
  payload parsing, dedupe. Prove they fail before implementing.

## Step 3 — Safety decisions (decide before exposing)

- **Sender allowlist**: `WHATSAPP_ALLOWED_NUMBERS` (comma-separated). Anyone who knows the business
  number could otherwise drive an agent that runs commands and edits files.
- **Mode**: force `ask` (or a restricted role) for WhatsApp; block slash commands like `/mode agent`,
  `/provider`, `/model` from this channel. `ChatHandler` currently processes them (`processMenuCommand`).
- **Sessions**: `ChatHandler` uses ONE current session per workspace (`loadCurrentSession`), and
  `setActiveSession` in `src/chat/session-store.ts` is process-global state. Two numbers writing at
  once would share/race one conversation. Need a session per phone number (named sessions — see the
  multi-session spec, `docs/multi-session-spec.md`) and serialize turns (one at a time, or per-number queue).
- Likely cleanest: a small `WhatsAppChannel` that owns per-number sessions and calls
  `agent.streamTurn` directly, rather than faking an OpenAI body into `ChatHandler`.

## Step 4 — Render config (`render.yaml`, currently an example)

Add, all `sync: false`: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ALLOWED_NUMBERS`. Webhook URL to register in Meta:
`https://<service>.onrender.com/webhooks/whatsapp`.

Open questions for the deploy:
- **Workspace**: `REI_WORKSPACE_PATH=/app` is the compiled image (no source, no `.git`), and Render's
  disk is ephemeral. Fine for an assistant; for editing a real repo, clone at startup or mount a disk.
- **Session persistence**: `.rei/` lives in the workspace → lost on every deploy/restart. Use a
  Render persistent disk or accept it.
- **Plan**: `starter` (512MB) is fine with OpenRouter; not with RAG/local embedder.
- **Free plan sleeps** → first webhook after idle may exceed Meta's timeout; Meta retries, dedupe covers it.

## Verify before finishing

```bash
npx tsc -p tsconfig.build.json --noEmit
npx vitest run
```
Plus: `docker build`, local run, `curl` the GET handshake and a signed POST.
