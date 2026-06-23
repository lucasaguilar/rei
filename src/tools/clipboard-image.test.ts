import { describe, it, expect } from "vitest";
import { grabClipboardImage } from "./clipboard-image.js";

describe("grabClipboardImage", () => {
  it("returns an unsupported-platform error on platforms with no clipboard backend", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "sunos" });
    try {
      const result = await grabClipboardImage();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not supported on this platform/);
      expect(result.filePath).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});
