/**
 * @fileoverview Minimal OAuth 2.0 provider for remote (HTTP) MCP servers that require the MCP
 * authorization flow — e.g. Atlassian's `https://mcp.atlassian.com/v1/mcp`. The MCP SDK does all the
 * heavy lifting (discovery, PKCE, token exchange/refresh, dynamic client registration); we just
 * implement the small `OAuthClientProvider` storage/redirect surface:
 *
 *   - tokens / client info / PKCE verifier  → one JSON file per server in ~/.rei/mcp-auth/
 *   - redirectToAuthorization                → open the browser + a tiny localhost callback server
 *
 * First connect opens a browser to log in (like Cursor). The refresh token is persisted, so later
 * runs — including headless `rei-server` — reuse it silently without another browser prompt.
 *
 * @module rei/tools/mcp/oauth-provider
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** Everything we persist for one server, in a single JSON file. */
interface AuthStore {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** How long to wait for the user to finish the browser login before giving up. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    // If we can't spawn a browser, the printed URL below is the fallback.
  }
  console.log(`[MCP OAuth] If your browser didn't open, visit:\n${url}\n`);
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly file: string;
  private store: AuthStore;
  private server?: http.Server;
  private port = 0;
  private codePromise?: Promise<string>;

  constructor(private readonly serverName: string) {
    const dir = path.join(os.homedir(), ".rei", "mcp-auth");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${serverName.replace(/[^\w.-]/g, "_")}.json`);
    this.store = this.load();
  }

  // --- persistence (one small JSON file) ------------------------------------

  private load(): AuthStore {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as AuthStore;
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.store, null, 2), {
        mode: 0o600,
      });
    } catch (err) {
      console.warn(`[MCP OAuth] Could not save credentials: ${String(err)}`);
    }
  }

  // --- localhost callback server (captures the ?code=...) -------------------

  /** Starts the loopback callback server so `redirectUrl` has a port. Call before connecting. */
  async start(): Promise<void> {
    if (this.server) return;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    this.codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(code ? 200 : 400, { "Content-Type": "text/html" });
      res.end(
        code
          ? "<h2>REI — login successful ✅</h2><p>You can close this tab and return to the terminal.</p>"
          : `<h2>REI — login failed</h2><p>${error ?? "missing authorization code"}</p>`,
      );
      if (code) resolveCode(code);
      else rejectCode(new Error(`OAuth callback error: ${error ?? "no code"}`));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  /** Resolves with the authorization code once the browser redirect hits the callback. */
  waitForCode(): Promise<string> {
    if (!this.codePromise) return Promise.reject(new Error("callback server not started"));
    // The timer is unref'd AND cleared once the race settles. Left running, a 5-minute timeout keeps
    // Node's event loop alive long after a successful 10-second login — harmless in the interactive
    // CLI, but it stops a one-shot command (`rei plan "…"`) from ever exiting.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Timed out waiting for browser login")),
        LOGIN_TIMEOUT_MS,
      );
      timeoutId.unref?.();
    });
    // `.finally` here is safe (unlike chaining it onto a bare connect promise): the promise it
    // returns IS the one the caller awaits, so a rejection can never go unhandled.
    return Promise.race([this.codePromise, timeout]).finally(() =>
      clearTimeout(timeoutId),
    );
  }

  /** Closes the callback server. Call once the flow is done (success or failure). */
  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  // --- OAuthClientProvider interface ----------------------------------------

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `REI (${this.serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client — PKCE, no secret
    };
  }

  state(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.clientInformation = info;
    this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.store.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.tokens = tokens;
    this.persist();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.codeVerifier = codeVerifier;
    this.persist();
  }

  codeVerifier(): string {
    if (!this.store.codeVerifier) throw new Error("No PKCE code verifier saved");
    return this.store.codeVerifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    console.log(`\n[MCP OAuth] 🔑 Authorizing "${this.serverName}" — opening your browser to log in…`);
    openBrowser(authorizationUrl.toString());
  }
}
