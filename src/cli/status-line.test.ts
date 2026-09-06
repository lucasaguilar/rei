import { describe, it, expect } from "vitest";
import {
  formatStatusLine,
  SPINNER_FRAMES,
  THINKING_TEXT,
} from "./constants/chat.constants.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The status line is the only thing on screen while a local model reasons — quiet mode no longer
 * streams the thinking, so a frozen label would be indistinguishable from a hung process.
 */
describe("formatStatusLine", () => {
  it("shows the phase and how long it has been running", () => {
    expect(plain(formatStatusLine("⠹", "thinking", 8000))).toBe("⠹ thinking · 8s");
  });

  it("switches to minutes past a minute, zero-padding the seconds", () => {
    // A local model can think for minutes; "95s" reads as noise, "1m 35s" as a duration.
    expect(plain(formatStatusLine("⠋", "thinking", 95_000))).toBe("⠋ thinking · 1m 35s");
    expect(plain(formatStatusLine("⠋", "thinking", 605_000))).toBe("⠋ thinking · 10m 05s");
  });

  it("starts at 0s rather than blank", () => {
    expect(plain(formatStatusLine("⠋", "thinking", 0))).toContain("0s");
  });
});

describe("SPINNER_FRAMES", () => {
  it("keeps every frame one column wide, so the line does not jitter", () => {
    // The old |/-\ cycle changed width between frames and visibly jerked at the 100ms tick.
    for (const f of SPINNER_FRAMES) expect([...f]).toHaveLength(1);
  });

  it("has enough frames to read as motion", () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SPINNER_FRAMES).size).toBe(SPINNER_FRAMES.length);
  });
});

describe("THINKING_TEXT", () => {
  it("labels every phase as a state, lowercase and without trailing dots", () => {
    // It sits under a wall of tool lines: a state reads better there than an announcement.
    for (const label of Object.values(THINKING_TEXT)) {
      expect(label).toBe(label.toLowerCase());
      expect(label.endsWith(".")).toBe(false);
      expect(label.length).toBeLessThanOrEqual(24);
    }
  });

  it("calls the post-tool phase thinking, not calling model", () => {
    expect(THINKING_TEXT.calling_model).toBe("thinking");
  });
});
