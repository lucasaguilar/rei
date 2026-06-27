import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractImagePaths,
  extractPdfPaths,
  imageMimeType,
  getVisionConfig,
  isImageOnlyInput,
  isAttachmentOnlyInput,
} from "./vision-sidecar.js";

describe("imageMimeType", () => {
  it("maps known image extensions (case-insensitive)", () => {
    expect(imageMimeType("a.png")).toBe("image/png");
    expect(imageMimeType("a.PNG")).toBe("image/png");
    expect(imageMimeType("a.jpg")).toBe("image/jpeg");
    expect(imageMimeType("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("a.webp")).toBe("image/webp");
    expect(imageMimeType("a.gif")).toBe("image/gif");
    expect(imageMimeType("a.bmp")).toBe("image/bmp");
  });

  it("returns undefined for non-image extensions", () => {
    expect(imageMimeType("a.txt")).toBeUndefined();
    expect(imageMimeType("a.ts")).toBeUndefined();
    expect(imageMimeType("noext")).toBeUndefined();
  });
});

describe("extractPdfPaths", () => {
  let tmpDir: string;
  let plainPdf: string;
  let spacedPdf: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-pdf-test-"));
    plainPdf = path.join(tmpDir, "report.pdf");
    spacedPdf = path.join(tmpDir, "Mi Documento.pdf");
    fs.writeFileSync(plainPdf, "fake");
    fs.writeFileSync(spacedPdf, "fake");
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("detects a bare absolute pdf path", () => {
    expect(extractPdfPaths(`extract data from ${plainPdf}`, tmpDir)).toEqual([plainPdf]);
  });

  it("detects a quoted pdf path with spaces", () => {
    expect(extractPdfPaths(`'${spacedPdf}'`, tmpDir)).toEqual([spacedPdf]);
  });

  it("does NOT match image extensions or non-existent pdfs", () => {
    expect(extractPdfPaths("look at shot.png", tmpDir)).toEqual([]);
    expect(extractPdfPaths("see /nope/ghost.pdf", tmpDir)).toEqual([]);
  });

  it("isAttachmentOnlyInput is true for a lone pdf, false with a question", () => {
    expect(isAttachmentOnlyInput(plainPdf, tmpDir)).toBe(true);
    expect(isAttachmentOnlyInput(`${plainPdf} is this Argentine?`, tmpDir)).toBe(false);
  });
});

describe("extractImagePaths", () => {
  let tmpDir: string;
  let plainPng: string;
  let spacedPng: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-vision-test-"));
    plainPng = path.join(tmpDir, "shot.png");
    spacedPng = path.join(tmpDir, "Captura de pantalla.png");
    fs.writeFileSync(plainPng, "fake");
    fs.writeFileSync(spacedPng, "fake");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects a bare absolute image path", () => {
    expect(extractImagePaths(`look at ${plainPng}`, tmpDir)).toEqual([plainPng]);
  });

  it("detects a backslash-escaped path with spaces (terminal drag style)", () => {
    const escaped = spacedPng.replace(/ /g, "\\ ");
    expect(extractImagePaths(`analyze ${escaped}`, tmpDir)).toEqual([spacedPng]);
  });

  it("detects a single-quoted path with spaces", () => {
    expect(extractImagePaths(`'${spacedPng}'`, tmpDir)).toEqual([spacedPng]);
  });

  it("detects a whole-input dragged path with UNescaped spaces (macOS screenshot)", () => {
    // The whole input is the path and some spaces are not escaped — token scan can't
    // bound it, but the whole-input fallback resolves it.
    expect(extractImagePaths(spacedPng, tmpDir)).toEqual([spacedPng]);
  });

  it("detects a macOS-style screenshot name with parens and unescaped spaces", () => {
    const macName = path.join(tmpDir, "Captura a la(s) 6.07 p. m..png");
    fs.writeFileSync(macName, "fake");
    try {
      expect(extractImagePaths(macName, tmpDir)).toEqual([macName]);
    } finally {
      fs.rmSync(macName, { force: true });
    }
  });

  it("detects a relative path resolved against the workspace", () => {
    expect(extractImagePaths("check shot.png please", tmpDir)).toEqual([
      plainPng,
    ]);
  });

  it("detects an @-prefixed path", () => {
    expect(extractImagePaths("@shot.png", tmpDir)).toEqual([plainPng]);
  });

  it("detects a leading dragged path FOLLOWED by a question (regular spaces)", () => {
    const input = `${spacedPng} can you see the scroll?`;
    expect(extractImagePaths(input, tmpDir)).toEqual([spacedPng]);
  });

  it("detects a macOS path with a U+202F unicode space + trailing question", () => {
    // macOS time strings use U+202F (narrow no-break space), which terminals don't escape.
    const macName = path.join(tmpDir, "Captura 10.48.27 a. m..png");
    fs.writeFileSync(macName, "fake");
    try {
      const input = `${macName} ahora podes ver el scroll horizontal?`;
      expect(extractImagePaths(input, tmpDir)).toEqual([macName]);
    } finally {
      fs.rmSync(macName, { force: true });
    }
  });

  it("ignores image paths that do not exist on disk", () => {
    expect(extractImagePaths("/nope/missing.png", tmpDir)).toEqual([]);
  });

  it("ignores non-image text", () => {
    expect(extractImagePaths("just a normal sentence", tmpDir)).toEqual([]);
  });

  it("dedupes the same image referenced twice", () => {
    expect(
      extractImagePaths(`${plainPng} and again ${plainPng}`, tmpDir),
    ).toEqual([plainPng]);
  });

  describe("isImageOnlyInput", () => {
    it("is true for a bare dragged path (no text)", () => {
      expect(isImageOnlyInput(plainPng, tmpDir)).toBe(true);
    });

    it("is true for a path with unescaped spaces (macOS screenshot, no text)", () => {
      expect(isImageOnlyInput(spacedPng, tmpDir)).toBe(true);
    });

    it("is true for a relative image filename only", () => {
      expect(isImageOnlyInput("shot.png", tmpDir)).toBe(true);
    });

    it("is false when the user adds a question alongside the path", () => {
      expect(
        isImageOnlyInput(`${plainPng} what is this error?`, tmpDir),
      ).toBe(false);
      expect(
        isImageOnlyInput("look at shot.png and explain it", tmpDir),
      ).toBe(false);
    });
  });
});

describe("getVisionConfig", () => {
  const saved = {
    REI_VISION_MODEL: process.env.REI_VISION_MODEL,
    LLM_STUDIO_MODEL: process.env.LLM_STUDIO_MODEL,
    REI_VISION_BASE_URL: process.env.REI_VISION_BASE_URL,
    LLM_STUDIO_BASE_URL: process.env.LLM_STUDIO_BASE_URL,
  };

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns null when no model is configured", () => {
    delete process.env.REI_VISION_MODEL;
    delete process.env.LLM_STUDIO_MODEL;
    expect(getVisionConfig()).toBeNull();
  });

  it("uses REI_VISION_MODEL and defaults the base URL to local LM Studio", () => {
    delete process.env.LLM_STUDIO_MODEL;
    delete process.env.REI_VISION_BASE_URL;
    delete process.env.LLM_STUDIO_BASE_URL;
    process.env.REI_VISION_MODEL = "qwen/qwen3.6-35b-a3b";
    const cfg = getVisionConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("qwen/qwen3.6-35b-a3b");
    expect(cfg!.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("strips trailing slashes from the base URL", () => {
    process.env.REI_VISION_MODEL = "m";
    process.env.REI_VISION_BASE_URL = "http://localhost:1234/v1/";
    expect(getVisionConfig()!.baseUrl).toBe("http://localhost:1234/v1");
  });
});
