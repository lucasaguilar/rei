import { describe, it, expect } from "vitest";
import { loadSettings, saveSettings } from "./settings.js";
import { KNOBS } from "../renderer/knobs.js";

const memoryFs = (initial) => {
  const files = new Map(initial ? [["/s.json", initial]] : []);
  return {
    files,
    readFile: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p);
    },
    writeFile: (p, data) => void files.set(p, data),
  };
};

/**
 * The monitor remembers its phosphor and its knobs. What it reads back is a file a person can edit
 * and an older version may have written, so it is validated, never trusted.
 */
describe("settings", () => {
  it("starts amber with every knob at its default when there is no file yet", () => {
    const s = loadSettings("/s.json", memoryFs());
    expect(s.phosphor).toBe("amber");
    for (const k of KNOBS) expect(s.knobs[k.key], k.key).toBe(k.default);
  });

  it("reads back what it saved", () => {
    const fs = memoryFs();
    saveSettings("/s.json", { phosphor: "green", knobs: { curvature: 0.1 } }, fs);
    const s = loadSettings("/s.json", fs);
    expect(s.phosphor).toBe("green");
    expect(s.knobs.curvature).toBe(0.1);
  });

  it("falls back to amber for a phosphor it does not know", () => {
    expect(loadSettings("/s.json", memoryFs('{"phosphor":"plasma"}')).phosphor).toBe("amber");
  });

  it("clamps knobs into range and drops ones that are not numbers", () => {
    const s = loadSettings("/s.json", memoryFs('{"knobs":{"scanlines":9,"bloom":"lots","curvature":-1}}'));
    const range = (key) => KNOBS.find((k) => k.key === key);
    expect(s.knobs.scanlines).toBe(range("scanlines").max);
    expect(s.knobs.curvature).toBe(range("curvature").min);
    expect(s.knobs.bloom).toBe(range("bloom").default);
  });

  it("survives a corrupt file instead of refusing to open", () => {
    expect(loadSettings("/s.json", memoryFs("{not json")).phosphor).toBe("amber");
  });
});
