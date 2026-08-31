import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { executeCommand } from "./command-executor.js";

/**
 * Commands run with `shell: false`, so nothing expands `$VAR` unless REI does it. Without expansion
 * `curl -H "Authorization: Bearer $TOKEN"` sends the literal string and the model gets an
 * unexplained 401 — the failure that motivated this.
 *
 * The single-quote rule carries the risk: `awk '{print $1}'` and `sed 's/$x/y/'` are allow-listed
 * and must survive untouched, which is exactly why shell semantics (no expansion inside single
 * quotes) is the rule rather than "replace every $NAME".
 */
let url = "";
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null, body: body || null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/x`;
  process.env.REI_TEST_TOKEN = "tok_secret_123";
  process.env.REI_TEST_WORD = "hello";
});

afterAll(() => {
  server.close();
  delete process.env.REI_TEST_TOKEN;
  delete process.env.REI_TEST_WORD;
});

const run = (cmd: string) => executeCommand(cmd, process.cwd());

describe("env-var expansion in run_command", () => {
  it("expands inside double quotes — the token case", async () => {
    const r = await run(`curl -s -H "Authorization: Bearer $REI_TEST_TOKEN" ${url}`);
    expect(JSON.parse(r.stdout).auth).toBe("Bearer tok_secret_123");
  });

  it("expands when unquoted", async () => {
    const r = await run(`curl -s -H Authorization:$REI_TEST_TOKEN ${url}`);
    expect(JSON.parse(r.stdout).auth).toBe("tok_secret_123");
  });

  it("expands the ${VAR} form", async () => {
    const r = await run(`curl -s -H "Authorization: Bearer ${"${REI_TEST_TOKEN}"}" ${url}`);
    expect(JSON.parse(r.stdout).auth).toBe("Bearer tok_secret_123");
  });

  it("does NOT expand inside single quotes", async () => {
    const r = await run(`curl -s -H 'Authorization: Bearer $REI_TEST_TOKEN' ${url}`);
    expect(JSON.parse(r.stdout).auth).toBe("Bearer $REI_TEST_TOKEN");
  });

  it("an undefined variable stays literal, not empty", async () => {
    const r = await run(`curl -s -H "Authorization: Bearer $REI_NO_EXISTE_XYZ" ${url}`);
    expect(JSON.parse(r.stdout).auth).toBe("Bearer $REI_NO_EXISTE_XYZ");
  });

  it("does not break awk's $1 inside single quotes", async () => {
    const r = await run(`echo "a b c" | awk '{print $1}'`);
    expect(r.stdout.trim()).toBe("a");
  });

  it("leaves $1 alone even in double quotes — it is not a variable name", async () => {
    const r = await run(`echo "a b c" | awk "{print $1}"`);
    expect(r.stdout.trim()).toBe("a");
  });

  it("leaves curl -w's %{...} alone", async () => {
    const r = await run(`curl -s -o /dev/null -w "%{http_code}" ${url}`);
    expect(r.stdout.trim()).toBe("200");
  });

  it("expands in a POST while leaving the single-quoted json body intact", async () => {
    const r = await run(
      `curl -s -X POST -H "Authorization: Bearer $REI_TEST_TOKEN" -d '{"a":1,"b":"x y"}' ${url}`,
    );
    const got = JSON.parse(r.stdout);
    expect(got.auth).toBe("Bearer tok_secret_123");
    expect(got.body).toBe('{"a":1,"b":"x y"}');
  });

  it("a variable cannot smuggle a forbidden keyword by indirection", async () => {
    process.env.REI_TEST_EVIL = "rm -rf /tmp/whatever";
    const r = await run(`echo $REI_TEST_EVIL`);
    delete process.env.REI_TEST_EVIL;
    expect(r.success).toBe(false);
    expect(r.stderr).toMatch(/forbidden keywords/);
  });
});
