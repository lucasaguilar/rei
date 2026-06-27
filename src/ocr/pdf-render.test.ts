import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { renderPdfPages } from "./pdf-render.js";

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

describe("renderPdfPages", () => {
  let tmpDir: string;
  let pdfPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-pdfrender-test-"));
    pdfPath = path.join(tmpDir, "scan.pdf");
    fs.writeFileSync(pdfPath, MINIMAL_PDF);
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("rasterizes pages to PNG data URLs (zero-install, pdf-parse getScreenshot)", async () => {
    const render = await renderPdfPages(pdfPath, { scale: 2 });
    expect(render.total).toBe(1);
    expect(render.truncated).toBe(false);
    expect(render.pages).toHaveLength(1);
    expect(render.pages[0].pageNumber).toBe(1);
    expect(render.pages[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(render.pages[0].dataUrl.length).toBeGreaterThan(1000);
  });
});
