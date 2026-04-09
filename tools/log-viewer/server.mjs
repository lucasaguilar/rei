import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.REI_LOG_VIEWER_PORT || 4173);

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, "tools/log-viewer/index.html");
const LOG_PATH = process.env.REI_LOG_PATH
  ? path.resolve(process.env.REI_LOG_PATH)
  : path.join(ROOT, ".rei/logs/agent-flow.jsonl");

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (url.pathname === "/api/log") {
      if (!existsSync(LOG_PATH)) {
        sendJson(res, 404, { error: "Log file not found", logPath: LOG_PATH });
        return;
      }

      const text = await readFile(LOG_PATH, "utf-8");
      sendJson(res, 200, {
        logPath: path.relative(ROOT, LOG_PATH),
        content: text,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(HTML_PATH, "utf-8");
      sendHtml(res, html);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, {
      error: "Server error",
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`REI Log Viewer running at http://${HOST}:${PORT}`);
  console.log(`Reading log from ${LOG_PATH}`);
});
