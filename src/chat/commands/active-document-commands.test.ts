import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activeDocumentCommands } from "./active-document-commands.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

describe("activeDocumentCommands", () => {
  let ws: string;
  let session: ChatSession;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-doc-active-"));
    fs.mkdirSync(path.join(ws, "ocr"));
    fs.writeFileSync(path.join(ws, "ocr", "guia escaneada.ocr.md"), "x");
    fs.writeFileSync(path.join(ws, "ocr", "otro.ocr.md"), "y");
    session = { messages: [], mode: "ask" };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const run = (command: string) =>
    activeDocumentCommands.run({
      command,
      session,
      workspacePath: ws,
      provider: {} as unknown as ModelProvider,
    }) as ReturnType<typeof activeDocumentCommands.run> & { success: boolean; response: string };

  it("owns /doc and /docs but not /ask-document or /read-document", () => {
    expect(activeDocumentCommands.match("/docs")).toBe(true);
    expect(activeDocumentCommands.match("/doc")).toBe(true);
    expect(activeDocumentCommands.match("/doc use x.md")).toBe(true);
    expect(activeDocumentCommands.match("/ask-document x what?")).toBe(false);
    expect(activeDocumentCommands.match("/read-document x")).toBe(false);
    expect(activeDocumentCommands.match("/doctor")).toBe(false);
  });

  it("/docs lists text docs and marks the active one", async () => {
    session.activeDocument = "ocr/otro.ocr.md";
    const r = await run("/docs");
    expect(r.success).toBe(true);
    expect(r.response).toContain("ocr/guia escaneada.ocr.md");
    expect(r.response).toContain("▶ ocr/otro.ocr.md");
  });

  it("/doc shows none, then the active document", async () => {
    expect((await run("/doc")).response).toContain("No hay documento activo");
    session.activeDocument = "ocr/guia escaneada.ocr.md";
    expect((await run("/doc")).response).toContain("ocr/guia escaneada.ocr.md");
  });

  it("/doc use <spaced file> activates it (stored workspace-relative)", async () => {
    const r = await run("/doc use ocr/guia escaneada.ocr.md");
    expect(r.success).toBe(true);
    expect(session.activeDocument).toBe("ocr/guia escaneada.ocr.md");
  });

  it("/doc use reports a missing file without activating", async () => {
    const r = await run("/doc use ocr/nope.ocr.md");
    expect(r.success).toBe(false);
    expect(session.activeDocument).toBeUndefined();
  });

  it("/doc clear deactivates", async () => {
    session.activeDocument = "ocr/otro.ocr.md";
    const r = await run("/doc clear");
    expect(r.success).toBe(true);
    expect(session.activeDocument).toBeUndefined();
  });
});
