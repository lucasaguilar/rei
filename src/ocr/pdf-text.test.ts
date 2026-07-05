import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractPdfText, stripPageMarkers } from "./pdf-text.js";

// A minimal one-page PDF whose content stream draws the text "Hello OCR World 123".
const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 18 Tf 20 100 Td (Hello OCR World 123) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

describe("extractPdfText", () => {
  let tmpDir: string;
  let pdfPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-pdftext-test-"));
    pdfPath = path.join(tmpDir, "doc.pdf");
    fs.writeFileSync(pdfPath, MINIMAL_PDF);
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("extracts the text layer of a digital PDF", async () => {
    const res = await extractPdfText(pdfPath);
    expect(res.text).toContain("Hello OCR World 123");
    expect(res.hasTextLayer).toBe(true);
    expect(res.pages).toBe(1);
  });
});

describe("stripPageMarkers", () => {
  it("removes pdf-parse page separators in various spacings", () => {
    expect(stripPageMarkers("-- 1 of 23 --")).toBe("");
    expect(stripPageMarkers("--1 of 23--")).toBe("");
    expect(stripPageMarkers("--  10  of  84  --")).toBe("");
  });

  it("reduces a scanned (marker-only) extraction to no real content — the bug case", () => {
    // What pdf-parse returns for a 23-page image-only PDF: separators, zero text between them.
    const scanned = Array.from({ length: 23 }, (_, i) => `-- ${i + 1} of 23 --`).join("\n\n");
    // ~300 chars of markers used to pass the 16-char threshold and mask an empty text layer.
    expect(scanned.length).toBeGreaterThan(16);
    // After stripping markers + whitespace there is nothing left → hasTextLayer must be false.
    expect(stripPageMarkers(scanned).replace(/\s+/g, "").length).toBe(0);
  });

  it("preserves real page content while dropping the markers", () => {
    const digital = "-- 1 of 2 --\nHomo sapiens\n-- 2 of 2 --\nes discutible";
    const stripped = stripPageMarkers(digital);
    expect(stripped).toContain("Homo sapiens");
    expect(stripped).toContain("es discutible");
    expect(stripped).not.toContain("of 2");
  });
});
