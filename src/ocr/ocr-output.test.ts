import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { prepareExtractedText } from "./ocr-output.js";

describe("prepareExtractedText", () => {
  let tmpDir: string;
  let src: string;
  const saved = {
    REI_OCR_SAVE: process.env.REI_OCR_SAVE,
    REI_OCR_INLINE_MAX_CHARS: process.env.REI_OCR_INLINE_MAX_CHARS,
    REI_OCR_OUT_DIR: process.env.REI_OCR_OUT_DIR,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-ocrout-test-"));
    src = path.join(tmpDir, "doc.pdf");
    fs.writeFileSync(src, "fake");
    delete process.env.REI_OCR_SAVE;
    delete process.env.REI_OCR_OUT_DIR;
    process.env.REI_OCR_INLINE_MAX_CHARS = "100"; // small threshold for testing
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("injects small text whole, no file", async () => {
    const r = await prepareExtractedText(src, "short text", 1);
    expect(r.truncated).toBe(false);
    expect(r.savedPath).toBeUndefined();
    expect(r.inject).toBe("short text");
  });

  it("saves a large doc INSIDE the workspace (.rei/ocr), not next to the source", async () => {
    const ws = path.join(tmpDir, "workspace");
    fs.mkdirSync(ws);
    const big = "A".repeat(500);
    const r = await prepareExtractedText(src, big, 84, { workspacePath: ws });
    expect(r.truncated).toBe(true);
    // file lives under <workspace>/.rei/ocr, NOT next to the source (tmpDir)
    expect(r.savedPath).toBe(path.join(ws, ".rei", "ocr", "doc.ocr.md"));
    expect(fs.existsSync(path.join(tmpDir, "doc.ocr.md"))).toBe(false);
    // injected text is the preview (<= threshold) + a TRUNCATED note, NOT the whole thing
    expect(r.inject.length).toBeLessThan(big.length);
    expect(r.inject).toContain("TRUNCATED");
    expect(r.inject).toContain("84 page");
    // the FULL text is on disk
    const onDisk = fs.readFileSync(r.savedPath!, "utf-8");
    expect(onDisk).toContain(big);
    expect(onDisk).toContain("Extracted text");
  });

  it("honors REI_OCR_OUT_DIR (relative to the workspace)", async () => {
    const ws = path.join(tmpDir, "ws2");
    fs.mkdirSync(ws);
    process.env.REI_OCR_OUT_DIR = "extracted";
    const r = await prepareExtractedText(src, "B".repeat(500), 3, { workspacePath: ws });
    expect(r.savedPath).toBe(path.join(ws, "extracted", "doc.ocr.md"));
  });

  it("REI_OCR_SAVE=1 forces a file even for small docs", async () => {
    process.env.REI_OCR_SAVE = "1";
    const r = await prepareExtractedText(src, "tiny", 1);
    expect(r.truncated).toBe(false);
    expect(r.savedPath).toBe(path.join(tmpDir, "doc.ocr.md"));
    expect(r.inject).toContain("tiny");
    expect(r.inject).toContain("also saved");
  });
});
