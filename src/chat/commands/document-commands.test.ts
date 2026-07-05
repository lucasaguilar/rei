import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { documentCommands, splitFileAndRest } from "./document-commands.js";
import type { ChatSession } from "../types.js";
import type { ModelProvider } from "../../providers/model-provider.js";

describe("documentCommands handler", () => {
  let ws: string;
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-doccmd-test-"));
    fs.mkdirSync(path.join(ws, "ocr"));
    fs.writeFileSync(
      path.join(ws, "ocr", "doc.ocr.md"),
      "# Extracted text — doc.pdf\n\n> 2 page(s), 10 chars.\n\n---\n\n" +
        "First page text.\n-- 1 of 2 --\nSecond page text.\n-- 2 of 2 --",
    );
    // A filename WITH a space — the case that broke the old (\S+) parser.
    fs.writeFileSync(path.join(ws, "ocr", "guia escaneada.ocr.md"), "Hola mundo.");
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  const ctx = (command: string) => ({
    command,
    workspacePath: ws,
    session: { messages: [], mode: "ask" } as ChatSession,
    provider: {} as unknown as ModelProvider,
  });

  it("matches ask/read-document WITH args but not bare/invalid forms (behavior-preserving)", () => {
    expect(documentCommands.match("/read-document ocr/doc.ocr.md")).toBe(true);
    expect(documentCommands.match("/ask-document ocr/doc.ocr.md what?")).toBe(true);
    expect(documentCommands.match("/ask-document")).toBe(false); // no args → legacy fallback
    expect(documentCommands.match("/help")).toBe(false);
  });

  it("/read-document returns the literal page slice", async () => {
    const r = await documentCommands.run(ctx("/read-document ocr/doc.ocr.md p.1"));
    expect(r.success).toBe(true);
    expect(r.response).toContain("First page text");
    expect(r.response).not.toContain("Second page");
  });

  it("/read-document reports a missing file", async () => {
    const r = await documentCommands.run(ctx("/read-document ocr/nope.ocr.md"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("File not found");
  });

  it("/read-document handles a spaced @-path (regression: 'File not found: ocr/guia')", async () => {
    const r = await documentCommands.run(
      ctx("/read-document @ocr/guia escaneada.ocr.md"),
    );
    expect(r.success).toBe(true);
    expect(r.response).toContain("Hola mundo");
  });
});

describe("splitFileAndRest", () => {
  let ws: string;
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-split-test-"));
    fs.mkdirSync(path.join(ws, "ocr"));
    fs.writeFileSync(path.join(ws, "ocr", "guia escaneada.ocr.md"), "x");
    fs.writeFileSync(path.join(ws, "notes.md"), "x");
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("keeps a spaced @-path together and splits off the question", () => {
    const r = splitFileAndRest("@ocr/guia escaneada.ocr.md que dice del juego?", ws);
    expect(r).toEqual({ file: "ocr/guia escaneada.ocr.md", rest: "que dice del juego?" });
  });

  it("spaced path, no trailing text", () => {
    const r = splitFileAndRest("ocr/guia escaneada.ocr.md", ws);
    expect(r).toEqual({ file: "ocr/guia escaneada.ocr.md", rest: "" });
  });

  it("honors quoted paths", () => {
    const r = splitFileAndRest('"ocr/guia escaneada.ocr.md" pp.3-5', ws);
    expect(r).toEqual({ file: "ocr/guia escaneada.ocr.md", rest: "pp.3-5" });
  });

  it("normal space-free file + question still works", () => {
    expect(splitFileAndRest("notes.md summarize it", ws)).toEqual({
      file: "notes.md",
      rest: "summarize it",
    });
  });

  it("falls back to first word when nothing matches on disk", () => {
    expect(splitFileAndRest("missing.md some question", ws)).toEqual({
      file: "missing.md",
      rest: "some question",
    });
  });
});
