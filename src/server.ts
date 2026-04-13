import * as http from "node:http";
import { createModelProvider } from "./providers/provider-factory.js";
import { Agent } from "./core/agent.js";
import { ChatHandler } from "./server/chat-handler.js";
import { REI_LOGO } from "./cli/rei-logo.js";
import { isWorkspaceAllowed, getDefaultWorkspace } from "./server/workspace-config.js";

const PORT = process.env.REI_SERVER_PORT || 3000;
const WORKSPACE_PATH = process.env.REI_WORKSPACE_PATH || getDefaultWorkspace();

// Validar que el workspace sea uno permitido
if (!isWorkspaceAllowed(WORKSPACE_PATH)) {
  console.error(`❌ Workspace not allowed: ${WORKSPACE_PATH}`);
  process.exit(1);
}

async function startServer() {
  // 1. Instanciamos el Agente UNA SOLA VEZ al inicio del servidor
  const provider = createModelProvider();
  const agent = new Agent(provider, WORKSPACE_PATH);
  const chatHandler = new ChatHandler(agent, WORKSPACE_PATH);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const jsonBody = JSON.parse(body);
          
          // Configurar respuesta como Stream (SSE) compatible con OpenAI/Continue
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
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
              choices: [{
                index: 0,
                delta: { content },
                finish_reason: null,
              }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          };

          // Ejecutar el flow de REI con streaming
          await chatHandler.handleChatStream(jsonBody, sendChunk);

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
      res.end("Not Found. Use /chat/completions endpoint.");
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
