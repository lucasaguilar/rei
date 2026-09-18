import "./load-env.js"; // MUST be first: loads workspace .env with override (see load-env.ts) —
// same precedence as the CLI, so the server honors per-project .env even when started standalone.
import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { initTelemetry } from "./telemetry/init.js";
import {
  createModelProvider,
  resolveModelForMode,
} from "./providers/provider-factory.js";
import { Agent } from "./core/agent.js";
import { ChatHandler } from "./server/chat-handler.js";
import { HEALTH_BODY, HEALTH_PATH, isHealthProbe, normalizeRoutePath } from "./server/health.js";
import { REI_LOGO } from "./cli/rei-logo.js";
import {
  isWorkspaceAllowed,
  getDefaultWorkspace,
} from "./server/workspace-config.js";
import { startIndexingWorker, hasRagIndex } from "./context/rag/rag-indexer.js";
import { isRagEnabled } from "./context/rag/rag-enabled.js";

await initTelemetry();

/** `PORT` is what a PaaS injects (Render, Fly, Heroku); REI_SERVER_PORT wins when both are set. */
const PORT = Number(process.env.REI_SERVER_PORT || process.env.PORT || 3000);

/**
 * Loopback by default. `server.listen(PORT)` binds every interface, so the server that executes
 * commands and writes files in your repository was reachable from the whole network while the
 * startup banner said `localhost`. Anyone who wants it exposed says so with REI_SERVER_HOST.
 */
const HOST = process.env.REI_SERVER_HOST || "127.0.0.1";

/**
 * Optional shared secret, sent as `Authorization: Bearer <token>`. Unset means no check, which is
 * the sane default for a loopback-only server; setting REI_SERVER_HOST without this one is the
 * combination worth refusing, and startup does.
 */
const AUTH_TOKEN = process.env.REI_SERVER_TOKEN?.trim() || "";

/**
 * With no token there is nothing to steal a browser into sending, so `*` is fine and IDE clients
 * need it. With a token, a wildcard origin would let any page the user visits replay a request the
 * browser attaches credentials to — so the allowed origin becomes explicit.
 */
const ALLOWED_ORIGIN = AUTH_TOKEN ? (process.env.REI_SERVER_ORIGIN || "") : "*";

/** Constant-time compare that tolerates different lengths (they hash to unequal buffers anyway). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

if (HOST !== "127.0.0.1" && HOST !== "localhost" && !AUTH_TOKEN) {
  console.error(
    `❌ REI_SERVER_HOST=${HOST} exposes an agent that edits files and runs commands.\n` +
      `   Set REI_SERVER_TOKEN=<secret> as well, or bind to 127.0.0.1.`,
  );
  process.exit(1);
}
const WORKSPACE_PATH = process.env.REI_WORKSPACE_PATH || getDefaultWorkspace();

// Validar que el workspace sea uno permitido
if (!isWorkspaceAllowed(WORKSPACE_PATH)) {
  console.error(`❌ Workspace not allowed: ${WORKSPACE_PATH}`);
  process.exit(1);
}

async function startServer() {
  // Startup does the same work as the CLI's, and no more: every per-turn decision — which model
  // per mode, its tuning from rei.config.json, the reasoning budget, and whether the repo map is
  // injected at all (REI_ON_DEMAND_FILE_CONTEXT_<MODE>) — is resolved inside agent.streamTurn,
  // which both entrypoints call. There is deliberately no repo map built here: on-demand is the
  // default, so the map is built only for a mode that explicitly opted out, and only when a turn
  // actually needs it.
  console.log("🔍 Initializing workspace context (same flow as the CLI)...");

  // RAG in the background on first run — only when RAG is enabled, which it is not by default.
  if (isRagEnabled() && !hasRagIndex(WORKSPACE_PATH)) {
    console.log("[RAG] First run detected — starting background indexing...");
    startIndexingWorker(WORKSPACE_PATH, {
      onProgress: (indexed, total) => {
        if (indexed % 50 === 0 || indexed === total) {
          console.log(`📦 RAG indexing: ${indexed}/${total} nodes`);
        }
      },
      onDone: (msg) => console.log(`✅ RAG complete: ${msg}`),
    });
  }

  // 2. Instanciar Agente y Handler con el contexto inicial
  const provider = createModelProvider();
  const agent = new Agent(provider, WORKSPACE_PATH);
  const chatHandler = new ChatHandler(agent, WORKSPACE_PATH);

  // Connect configured MCP servers so their tools are available to every turn.
  // Best-effort: per-server failures are swallowed by the registry.
  try {
    await agent.connectMcp();
  } catch (error) {
    console.error(
      `⚠️  MCP startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const server = http.createServer(async (req, res) => {
    if (ALLOWED_ORIGIN) res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Liveness FIRST, before auth: a platform health check cannot send the bearer token, and a
    // 401 there reads as "unhealthy" and gets the service restarted in a loop. See server/health.ts.
    if (isHealthProbe(req.url, req.method)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(HEALTH_BODY);
      return;
    }

    if (AUTH_TOKEN) {
      const sent = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!timingSafeEqualStr(sent, AUTH_TOKEN)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error" } }));
        return;
      }
    }

    // Normalize the path so OpenAI-compatible clients work whether or not they add the `/v1`
    // prefix (Cline appends /v1 → /v1/chat/completions; Continue posts /chat/completions directly).
    // Also strip query strings and a trailing slash.
    const routePath = normalizeRoutePath(req.url);

    // GET /models (and /v1/models) — IDE clients probe this on connect to populate the model list.
    if (routePath === "/models" && req.method === "GET") {
      const ids = Array.from(
        new Set(
          [resolveModelForMode("ask"), resolveModelForMode("agent")].filter(
            Boolean,
          ),
        ),
      );
      const created = Math.floor(Date.now() / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: ids.map((id) => ({
            id,
            object: "model",
            created,
            owned_by: "rei",
          })),
        }),
      );
      return;
    }

    if (routePath === "/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const jsonBody = JSON.parse(body);

          // Configurar respuesta como Stream (SSE) compatible con OpenAI/Continue
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const requestedModel = jsonBody.model || "rei-agent";
          const now = Math.floor(Date.now() / 1000);

          // Función para enviar chunks en formato OpenAI SSE
          const sendChunk = (content: string) => {
            const payload = {
              id: `chatcmpl-${now}`,
              object: "chat.completion.chunk",
              created: now,
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          };

          // Ejecutar el flow de REI con streaming.
          // Durante operaciones largas (ng build, tsc, etc.) no se envían
          // tokens al cliente, lo que puede causar que el SSE idle timeout
          // cierre la conexión. Enviamos SSE comments (": heartbeat") cada
          // 10 segundos — son ignorados como datos pero mantienen el canal abierto.
          const keepalive = setInterval(() => {
            if (!res.writableEnded) res.write(": heartbeat\n\n");
          }, 10_000);

          try {
            await chatHandler.handleChatStream(jsonBody, sendChunk);
          } finally {
            clearInterval(keepalive);
          }

          // Enviar señal de finalización
          res.write(`data: [DONE]\n\n`);
          res.end();
        } catch (error) {
          console.error(`Error processing request:`, error);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal Server Error" }));
          } else {
            res.end();
          }
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(
        "Not Found. Use POST /chat/completions (or /v1/chat/completions), GET /models, GET /healthz.",
      );
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(REI_LOGO);
    console.log(`🚀 REI Server running at http://${HOST}:${PORT}`);
    if (AUTH_TOKEN) console.log(`Auth: Authorization: Bearer <REI_SERVER_TOKEN>`);
    console.log(`Workspace: ${WORKSPACE_PATH}`);
    console.log(`Endpoint: http://${HOST}:${PORT}/chat/completions`);
    console.log(`Health:   http://${HOST}:${PORT}${HEALTH_PATH} (no auth — for platform probes)`);
    console.log(`Flow: Session-aware + Streaming enabled.`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start REI server:", err);
  process.exit(1);
});
