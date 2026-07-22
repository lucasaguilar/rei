import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentLogger } from "./logger.js";

/**
 * getTurnId() is the surface the session uses to stamp ChatMessage.turnId so the flat message list
 * becomes segmentable (docs/context-drift-spec.md). It must be stable within a turn and change on
 * startTurn(), mirroring the id carried into agent-flow.jsonl.
 */
describe("AgentLogger turnId", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-logger-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes a non-empty turnId that is stable until startTurn()", () => {
    const logger = new AgentLogger(dir);
    const first = logger.getTurnId();
    expect(first).toBeTruthy();
    expect(logger.getTurnId()).toBe(first); // stable across reads within a turn
  });

  it("generates a fresh turnId on each startTurn()", () => {
    const logger = new AgentLogger(dir);
    const before = logger.getTurnId();
    logger.startTurn();
    const after = logger.getTurnId();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});
