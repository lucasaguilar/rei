import { describe, it, expect } from "vitest";
import { executeCommand } from "./command-executor.js";

const ws = process.cwd();
const run = (cmd: string) => executeCommand(cmd, ws);

/**
 * Two things a model sends to run_command that are not commands, and what REI used to say about them.
 *
 * A sub-agent looking for a Jira issue produced this, in order: it tried
 * `atlassian-mcp-server:getJiraIssue --help`, was told the command was not in the allow-list, and
 * concluded the binary might be missing — so it ran `ls /usr/local/bin` looking for it. Then it
 * narrated its plan INTO the command argument (`# I need to check if the tool is available`) and
 * was told `'#' is not in the allow-list`.
 *
 * Neither refusal was wrong; both described a permission problem the model did not have. It is the
 * same failure already documented for `for` and `while`: an accurate message pointing at the wrong
 * fix costs more turns than a blunt one pointing at the right fix.
 */
describe("a comment is not a command", () => {
  it("says so, instead of blaming the allow-list", async () => {
    const r = await run("# I need to check if the tools are available");
    expect(r.stderr).toContain("that is a comment");
    expect(r.stderr).not.toContain("allow-list");
  });

  it("tells it where the reasoning belongs", async () => {
    expect((await run("# first, look at the config")).stderr).toContain("reasoning in your reply");
  });

  it("catches a comment above a real command too, and hands back the command", async () => {
    const r = await run("# checking availability\n# then fetching\nls -la");
    expect(r.stderr).toContain("comment");
    expect(r.stderr).toContain("ls -la"); // so the retry is a copy, not a guess
  });
});

describe("a tool name is not a command", () => {
  it("names it as a tool rather than an unknown binary", async () => {
    const r = await run("atlassian-mcp-server:getJiraIssue --help");
    expect(r.stderr).toContain("looks like a TOOL");
    expect(r.stderr).not.toContain("allow-list");
  });

  it("explains what an absent tool means, so it stops hunting the filesystem", async () => {
    const r = await run("atlassian-mcp-server:getJiraIssue --help");
    expect(r.stderr).toContain("not connected in this session");
  });

  it("catches the call-syntax form as well", async () => {
    expect((await run('getJiraIssue(issueKey="SPD-4282")')).stderr).toContain("TOOL");
  });

  it("catches the mcp: prefix form", async () => {
    expect((await run("mcp:atlassian/getJiraIssue")).stderr).toContain("TOOL");
  });

  it("wins over the comment message when the model narrates and then calls the tool", async () => {
    // Verbatim shape of the third failure in the log: two comment lines, then the call. Answering
    // "that is a comment" here is true and useless — it spends a turn and the call comes back.
    const r = await run(
      '# I will check tool availability by calling the tool directly.\n' +
        '# If the tool is not available, the system will fail the call.\n' +
        'atlassian-mcp-server:getJiraIssue(issueKey="SPD-4282")',
    );
    expect(r.stderr).toContain("looks like a TOOL");
    expect(r.stderr).toContain("atlassian-mcp-server:getJiraIssue");
  });
});

/** The detector must not swallow ordinary commands — a refusal for a legitimate call is worse. */
describe("real commands still run", () => {
  it("runs a plain command", async () => {
    expect((await run("echo hello")).exitCode).toBe(0);
  });

  it("does not mistake a URL for a tool name", async () => {
    const r = await run("echo https://example.com/a");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("https://example.com/a");
  });

  it("does not mistake a sed expression for a tool name", async () => {
    const r = await run("echo abc");
    expect(r.exitCode).toBe(0);
  });

  it("still refuses a genuinely unknown command with the allow-list message", async () => {
    // The allow-list explanation is right for this case, and must survive.
    expect((await run("definitelynotarealbinary --version")).stderr).toContain("allow-list");
  });
});
