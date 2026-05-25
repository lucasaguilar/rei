# Adding MCP Servers to REI

REI supports two transport types for connecting to MCP (Model Context Protocol) servers:

| Transport | Use case                                                                                      | Config `type` |
| --------- | --------------------------------------------------------------------------------------------- | ------------- |
| **stdio** | Local servers spawned as child processes (e.g., filesystem, git, database tools)              | `"stdio"`     |
| **http**  | Remote servers reachable over HTTP (e.g., internal microservices, cloud-hosted MCP endpoints) | `"http"`      |

---

## 1. Configuration

All MCP servers are defined in a `rei.config.json` file placed in the workspace root. REI looks for it first in `<workspacePath>/rei.config.json`, then in `process.cwd()/rei.config.json`.

### Basic structure

```jsonc
// rei.config.json
{
  "mcpServers": {
    // Key = server name (used to qualify tool calls: "serverName/toolName")
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {
        "MY_VAR": "value"
      }
    }
  }
}
```

### Transport reference

#### stdio server

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "env": { "NODE_ENV": "production" }
    },
    "spotify": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\Users\\jlnbo\\Repos\\spotify-mcp-server\\build\\index.js"
      ]
    }
  }
}
```

| Field     | Required        | Description                                               |
| --------- | --------------- | --------------------------------------------------------- |
| `type`    | Yes (`"stdio"`) | Transport type                                            |
| `command` | Yes             | Executable path or name (searched in PATH)                |
| `args`    | No              | Arguments passed to the command                           |
| `env`     | No              | Extra environment variables merged into the child process |

#### HTTP server

```json
{
  "mcpServers": {
    "remote-api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sk-…",
        "X-Custom": "value"
      }
    }
  }
}
```

| Field     | Required       | Description                                                     |
| --------- | -------------- | --------------------------------------------------------------- |
| `type`    | Yes (`"http"`) | Transport type                                                  |
| `url`     | Yes            | Full URL to the MCP endpoint                                    |
| `headers` | No             | Custom HTTP headers sent with every request (e.g., auth tokens) |

---

## 2. Quick-start examples

### Add a filesystem server (stdio)

```json
{
  "mcpServers": {
    "fs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

After restarting REI, you can call tools like `fs/list_directory`, `fs/read_file`, etc.

### Add a remote dashboard server (HTTP)

```json
{
  "mcpServers": {
    "dashboard": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Restart REI, then tools like `dashboard/get-metrics` or `dashboard/list-alerts` will be available.

---

## 3. What happens at startup

When REI starts (or a session begins), the `McpRegistry`:

1. Reads `rei.config.json`
2. For each entry, creates a transport-specific client:
   - **stdio**: spawns the process, performs the MCP `initialize` handshake
   - **http**: opens a Streamable HTTP connection, performs the MCP `initialize` handshake
3. Calls `tools/list` to discover available tools
4. Prefixes each tool name with `serverName/` for global uniqueness
5. Registers the tools so the AI agent can invoke them

If a server fails to connect (binary not found, network timeout, etc.), REI logs a warning and continues — the remaining servers still work.

---

## 4. Invoking tools

REI uses a **qualified** naming scheme: `serverName/toolName`.

Examples:

| Qualified name          | Dispatches to                              |
| ----------------------- | ------------------------------------------ |
| `fs/read_file`          | Server `"fs"`, tool `"read_file"`          |
| `dashboard/get-metrics` | Server `"dashboard"`, tool `"get-metrics"` |

The agent automatically resolves these in `<call_tool>` tags.

---

## 5. Troubleshooting

### stdio: "Command not found"

Make sure the binary is installed and available in your PATH. Use an absolute path if unsure:

```json
{
  "type": "stdio",
  "command": "C:\\Users\\me\\node_modules\\.bin\\my-mcp-server.cmd"
}
```

### HTTP: "fetch failed"

- Verify the URL is reachable: `curl -v <url>`
- Check network / firewall rules
- If using HTTPS with a self-signed cert, configure the server accordingly

### Server starts but no tools are available

Run the server manually to verify it advertises tools:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx @modelcontextprotocol/server-filesystem /tmp
```

### REI doesn't seem to pick up the config

- Confirm the file is named `rei.config.json`
- Confirm it's in the workspace root (or the current working directory)
- Check for JSON syntax errors with `npx json5 < rei.config.json`

---

## 6. Architecture reference

```
rei.config.json
     │
     ▼
  McpRegistry.connect()
     │
     ├── config.type === "stdio"  →  StdioMcpClient.create()
     │                                  │
     │                                  ▼
     │                           StdioClientTransport
     │                           child_process.spawn()
     │
     └── config.type === "http"   →  HttpMcpClient.create()
                                        │
                                        ▼
                                 StreamableHTTPClientTransport
                                 HTTP POST / SSE
```

Both `StdioMcpClient` and `HttpMcpClient` implement the same `McpClient` interface, so the registry treats them identically.