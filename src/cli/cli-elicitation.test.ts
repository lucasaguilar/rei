import { describe, it, expect, vi } from "vitest";
import { CliElicitation, normalizeAnswer, type CliElicitDeps } from "./cli-elicitation.js";
import type { Elicitation } from "../chat/elicitation.js";

const selectReq: Elicitation = {
  id: "s",
  kind: "select",
  message: "login or signup?",
  options: [
    { value: "login", label: "Log in" },
    { value: "signup", label: "Sign up" },
  ],
  default: "login",
};
const textReq: Elicitation = { id: "t", kind: "text", message: "base url?", default: "" };

describe("normalizeAnswer", () => {
  it("maps a 1-based number to the option value", () => {
    expect(normalizeAnswer(selectReq, "2")).toBe("signup");
  });
  it("matches an option by value or label, case-insensitive", () => {
    expect(normalizeAnswer(selectReq, "SIGNUP")).toBe("signup");
    expect(normalizeAnswer(selectReq, "log in")).toBe("login");
  });
  it("passes an unrecognized select answer through verbatim (honest, no silent default)", () => {
    expect(normalizeAnswer(selectReq, "neither, I want red")).toBe("neither, I want red");
  });
  it("treats an empty select submit as a clean skip (empty string, not option 1)", () => {
    expect(normalizeAnswer(selectReq, "   ")).toBe("");
  });
  it("returns the trimmed free-form text, or the default when empty", () => {
    expect(normalizeAnswer(textReq, "  https://x.com  ")).toBe("https://x.com");
    expect(normalizeAnswer(textReq, "   ")).toBe("");
  });

  it("maps a confirm answer to yes/no bilingually, else the default", () => {
    const c: Elicitation = { id: "c", kind: "confirm", message: "run?", default: "no" };
    for (const yes of ["si", "sí", "SÍ", "y", "yes", "dale", "ok", "1"]) {
      expect(normalizeAnswer(c, yes)).toBe("yes");
    }
    for (const no of ["no", "n", "nope", "0"]) {
      expect(normalizeAnswer(c, no)).toBe("no");
    }
    expect(normalizeAnswer(c, "")).toBe("no"); // empty → default
    expect(normalizeAnswer(c, "quizás")).toBe("no"); // unrecognized → default
  });
});

function fakeDeps(): CliElicitDeps & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { pushTranscript: [], setBusy: [] };
  return {
    calls,
    pushTranscript: (l) => calls.pushTranscript.push(l),
    setBusy: (b) => calls.setBusy.push(b),
    stopSpinner: vi.fn(),
    draw: vi.fn(),
  };
}

describe("CliElicitation flow", () => {
  it("pauses on elicit and resolves with the delivered answer, then resumes", async () => {
    const deps = fakeDeps();
    const cli = new CliElicitation(deps);
    expect(cli.isPending).toBe(false);

    const promise = cli.elicit(selectReq);
    expect(cli.isPending).toBe(true);
    expect(deps.calls.setBusy).toEqual([false]); // paused: prompt shown, typing enabled
    expect(deps.calls.pushTranscript.length).toBe(1);

    const consumed = cli.deliver("2");
    expect(consumed).toBe(true);
    expect(cli.isPending).toBe(false);
    expect(deps.calls.setBusy).toEqual([false, true]); // resumed
    await expect(promise).resolves.toEqual({ id: "s", value: "signup" });
  });

  it("deliver returns false when nothing is pending", () => {
    const cli = new CliElicitation(fakeDeps());
    expect(cli.deliver("hello")).toBe(false);
  });
});
