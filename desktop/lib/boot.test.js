import { describe, it, expect } from "vitest";
import { bootLines } from "../renderer/boot.js";

describe("the boot screen", () => {
  const lines = bootLines({ workspace: "/home/u/app", phosphor: "amber", version: "0.1.0" });

  it("names the real workspace and phosphor", () => {
    expect(lines).toContain("Workspace: /home/u/app");
    expect(lines.join("\n")).toContain("phosphor P3 amber");
  });

  it("claims no check REI does not run — memory is the only test it counts", () => {
    const text = lines.join("\n").toLowerCase();
    for (const fake of ["model server", "detecting", "network", "ok\n"]) {
      expect(text, fake).not.toContain(fake);
    }
  });
});
