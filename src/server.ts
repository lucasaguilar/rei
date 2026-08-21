import "./load-env.js"; // MUST be first: loads workspace .env with override (see load-env.ts) —
// same precedence as the CLI, so the server honors per-project .env even when started standalone.
import * as http from "node:http";
import { initTelemetry } from "./telemetry/init.js";
import {
  createModelProvider,
  resolveModelForMode,
} from "./providers/provider-factory.js";
import { Agent } from "./core/agent.js";
import { ChatHandler } from "./server/chat-handler.js";
import { REI_LOGO } from "./cli/rei-logo.js";
import {
  isWorkspaceAllowed,
  getDefaultWorkspace,
} from "./server/workspace-config.js";
// Imports fundamentales para el REI Flow
import { scanWorkspace } from "./workspace/workspace-scanner.js";
import { generateRepoMap } from "./tools/repo-map-generator.js";
import { startIndexingWorker, hasRagIndex } from "./context/rag/rag-indexer.js";
import { isRagEnabled } from "./context/rag/rag-enabled.js";

await initTelemetry();

const PORT = process.env.REI_SERVER_PORT || 3000;
const WORKSPACE_PATH = process.env.REI_WORKSPACE_PATH || getDefaultWorkspace();

// Validar que el workspace sea uno permitido
if (!isWorkspaceAllowed(WORKSPACE_PATH)) {
  console.error(`❌ Workspace not allowed: ${WORKSPACE_PATH}`);
  process.exit(1);
}

async function startServer() {
  console.log("🔍 Initializing workspace context (matching CLI flow)...");

  // 1. Preparar el contexto igual que en runChat
  //const scannedFiles = scanWorkspace(WORKSPACE_PATH);
  //const repoMap = generateRepoMap(WORKSPACE_PATH);
  //console.log(`📁 Repo map generated with ${repoMap.length} entries.`);

  // Iniciar RAG en background si es la primera vez (solo si RAG está habilitado — OFF por default)
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
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Normalize the path so OpenAI-compatible clients work whether or not they add the `/v1`
    // prefix (Cline appends /v1 → /v1/chat/completions; Continue posts /chat/completions directly).
    // Also strip query strings and a trailing slash.
    const routePath =
      (req.url || "").split("?")[0].replace(/\/+$/, "").replace(/^\/v1/, "") ||
      "/";

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
        "Not Found. Use POST /chat/completions (or /v1/chat/completions) and GET /models.",
      );
    }
  });

  server.listen(PORT, () => {
    console.log(REI_LOGO);
    console.log(`🚀 REI Server running at http://localhost:${PORT}`);
    console.log(`Workspace: ${WORKSPACE_PATH}`);
    console.log(`Endpoint: http://localhost:${PORT}/chat/completions`);
    console.log(`Flow: Session-aware + Streaming enabled.`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start REI server:", err);
  process.exit(1);
});
