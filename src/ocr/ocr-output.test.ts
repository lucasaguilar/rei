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
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-ocrout-test-"));
    src = path.join(tmpDir, "doc.pdf");
    fs.writeFileSync(src, "fake");
    delete process.env.REI_OCR_SAVE;
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

  it("saves a large doc to <src>.ocr.md and injects a preview + pointer", async () => {
    const big = "A".repeat(500);
    const r = await prepareExtractedText(src, big, 84);
    expect(r.truncated).toBe(true);
    expect(r.savedPath).toBe(path.join(tmpDir, "doc.ocr.md"));
    // injected text is the preview (<= threshold) + a TRUNCATED note, NOT the whole thing
    expect(r.inject.length).toBeLessThan(big.length);
    expect(r.inject).toContain("TRUNCATED");
    expect(r.inject).toContain("84 page");
    // the FULL text is on disk
    const onDisk = fs.readFileSync(r.savedPath!, "utf-8");
    expect(onDisk).toContain(big);
    expect(onDisk).toContain("Extracted text");
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
