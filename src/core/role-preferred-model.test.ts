import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * An active role's `preferredModel` and `writeGlob` must reach EVERY turn, on every branch.
 *
 * `streamTurnInternal` forks: `session.mode === "agent"` takes one path, ask/planning the other.
 * The role fields were wired into the second and not the first — so exactly the roles that edit
 * code (`baseMode: agent`) ran on the session's model with NO write restriction, while `/roles`
 * and the status bar both reported the role's. The bar was the worst part: it named the model we
 * INTENDED, so it agreed with the documentation and disagreed with the backend.
 *
 * The first version of this test asserted the ABSENCE of one particular expression. It passed
 * before and after the fix, because the other branch spelled it differently
 * (`resolveModelForMode("agent")` rather than `resolveModelForMode(session.mode)`). Absence of one
 * spelling is not presence of the right thing — so this checks every call site instead.
 */
const AGENT = fs.readFileSync(path.resolve(__dirname, "agent.ts"), "utf-8");
const turnBody = AGENT.slice(AGENT.indexOf("private async *streamTurnInternal"));

/** Every `executeAgentTurnWithTools({...})` call inside streamTurnInternal, as source text. */
function turnCallSites(body: string): string[] {
  const sites: string[] = [];
  const marker = "executeAgentTurnWithTools({";
  for (let i = body.indexOf(marker); i !== -1; i = body.indexOf(marker, i + 1)) {
    let depth = 0;
    let j = i + marker.length - 1;
    for (; j < body.length; j++) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}" && --depth === 0) break;
    }
    sites.push(body.slice(i, j + 1));
  }
  return sites;
}

const sites = turnCallSites(turnBody);

describe("every turn honours the active role", () => {
  it("finds both branches — agent, and ask/planning", () => {
    // If this drops to one, the parametrisation below silently stops covering a path.
    expect(sites.length).toBe(2);
  });

  it("resolves ONE model for the turn, in the documented order of precedence", () => {
    // The turn delegates to the one resolver, instead of spelling the chain out again. It used to
    // be inline here AND in the status bar, and the two drifted: the bar named a model the turn was
    // not running on.
    const chain = turnBody.match(/const turnModel\s*=([\s\S]{0,160}?);/)?.[1] ?? "";
    expect(chain).toContain("resolveSessionModel(session");

    // And the resolver keeps the documented order: /model beats the role, which beats the mode's
    // configured model. activeManualModel is what drops a choice made for the OTHER model slot
    // (`/model agent X` then `/mode ask`) — see chat/manual-model.ts.
    const resolver = fs.readFileSync(
      path.resolve(__dirname, "../chat/manual-model.ts"),
      "utf-8",
    );
    const body = resolver.slice(resolver.indexOf("export function resolveSessionModel"));
    expect(body).toContain("activeManualModel(session");
    expect(body).toContain("role?.preferredModel");
    expect(body).toContain("resolveModelForMode");
    expect(body.indexOf("activeManualModel(session")).toBeLessThan(body.indexOf("role?.preferredModel"));
    expect(body.indexOf("role?.preferredModel")).toBeLessThan(body.indexOf("resolveModelForMode"));
  });

  it.each([0, 1])("branch %i sends that model, not one it resolves itself", (i) => {
    expect(sites[i]).toMatch(/modelOverride:\s*turnModel/);
  });

  it.each([0, 1])("branch %i narrows writes by the role", (i) => {
    expect(sites[i]).toMatch(/roleWriteGlob:\s*turnRole\?\.writeGlob/);
  });

  it("never re-resolves the model at a call site, in any spelling", () => {
    // The bug: one branch said resolveModelForMode("agent") while the other said
    // resolveModelForMode(session.mode). Matching either spelling alone misses the other.
    for (const site of sites) expect(site).not.toMatch(/modelOverride:\s*resolveModelForMode\(/);
  });

  it("resolves the tuning from the same value, so model and config cannot disagree", () => {
    expect(turnBody).toMatch(/setActiveModelTuning\(resolveModelTuning\(turnModel,/);
  });

  it("reports that model to the status bar, rather than letting it re-derive one", () => {
    expect(turnBody).toMatch(/this\.lastTurnModel\s*=\s*turnModel/);
  });
});
