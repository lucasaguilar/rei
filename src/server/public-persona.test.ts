import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describePublicPersona, resolvePublicPersona } from "./public-persona.js";

/**
 * Which persona answers on the public channels: REI_PUBLIC_PERSONA, else the shipped `general`.
 * A public channel never answers with the coding prompt, so a name that does not load falls back
 * rather than failing — and says so at startup, where the owner looks.
 */

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-public-persona-"));
  const dir = path.join(ws, ".rei", "personas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sales.md"), "---\nname: sales\ndescription: d\n---\n\nYou sell.\n");
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe("resolvePublicPersona", () => {
  it("is general when REI_PUBLIC_PERSONA is not set", () => {
    expect(resolvePublicPersona(ws, {})).toEqual({ name: "general" });
  });

  it("is the configured persona when it loads", () => {
    expect(resolvePublicPersona(ws, { REI_PUBLIC_PERSONA: " Sales " })).toEqual({ name: "sales" });
  });

  it("falls back to general, with a warning, when the configured one does not load", () => {
    const p = resolvePublicPersona(ws, { REI_PUBLIC_PERSONA: "ghost" });
    expect(p.name).toBe("general");
    expect(p.warning).toMatch(/REI_PUBLIC_PERSONA.*ghost.*not found/);
  });
});

describe("describePublicPersona", () => {
  it("names the persona, and the warning when there is one", () => {
    expect(describePublicPersona({ name: "sales" })).toBe("Public persona: sales");
    expect(describePublicPersona({ name: "general", warning: "W" })).toBe("Public persona: general ⚠️  W");
  });
});
