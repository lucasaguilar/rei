import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { processMenuCommand } from "./menu-command-processor.js";
import { listSessions, loadCurrentSession, saveSession } from "./session-store.js";
import type { ChatSession } from "./types.js";
import type { ModelProvider } from "../providers/model-provider.js";

describe("menu-command-processor session commands", () => {
  let tmpWorkspace: string;
  const provider = {} as ModelProvider;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rei-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("starts a new session without sending /session new to the model", async () => {
    const session: ChatSession = {
      mode: "ask",
      createdAt: "2026-05-16T00:00:00.000Z",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ],
    };

    saveSession(
      tmpWorkspace,
      session.messages,
      session.mode,
      session.summary,
      session.createdAt,
    );

    const result = await processMenuCommand(
      "/session new",
      session,
      tmpWorkspace,
      provider,
    );

    expect(result.success).toBe(true);
    expect(result.recordInSession).toBe(false);
    expect(result.newSession).toEqual({ messages: [], mode: "ask" });

    const current = loadCurrentSession(tmpWorkspace);
    expect(current?.messages).toEqual([]);
    expect(current?.mode).toBe("ask");

    const archived = listSessions(tmpWorkspace);
    expect(archived).toHaveLength(1);
    expect(archived[0].turns).toBe(1);
  });
});
