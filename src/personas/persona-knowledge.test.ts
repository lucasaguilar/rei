import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadInlineKnowledge } from "./persona-knowledge.js";

/**
 * A small knowledge base goes whole into the persona's prompt: always there, in one model call,
 * instead of rounds of searching it (most of a public reply's 30–40 s) — and a small model that
 * skips the search does not answer from memory. Only when ALL of it fits, and only text.
 */

let kb: string;
beforeEach(() => {
  kb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-kb-")));
});
afterEach(() => fs.rmSync(kb, { recursive: true, force: true }));

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true });
  fs.writeFileSync(path.join(kb, rel), content);
};

describe("loadInlineKnowledge", () => {
  it("returns every text file, by path relative to the directory, in a stable order", () => {
    write("pricing/plans.md", "Plan Pro");
    write("faq.md", "Q&A");
    write("hours.txt", "9 to 18");

    expect(loadInlineKnowledge(kb)).toEqual([
      { path: "faq.md", content: "Q&A" },
      { path: "hours.txt", content: "9 to 18" },
      { path: "pricing/plans.md", content: "Plan Pro" },
    ]);
  });

  it("is null when it does not fit — the persona searches it instead", () => {
    write("catalog.md", "x".repeat(4000));
    expect(loadInlineKnowledge(kb, 500)).toBeNull();
    expect(loadInlineKnowledge(kb, 2000)).not.toBeNull();
  });

  it("is null when the directory holds anything but text: only the read tools can reach the rest", () => {
    write("faq.md", "Q&A");
    write("brochure.pdf", "%PDF-1.7");
    expect(loadInlineKnowledge(kb)).toBeNull();
  });

  it("is null for an empty or missing directory", () => {
    expect(loadInlineKnowledge(kb)).toBeNull();
    expect(loadInlineKnowledge(path.join(kb, "nope"))).toBeNull();
  });

  it("skips hidden files and never follows a link out of the directory", () => {
    write("faq.md", "Q&A");
    write(".draft.md", "not yet");
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-kb-out-")));
    fs.writeFileSync(path.join(outside, "secret.md"), "INTERNAL");
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(kb, "linked.md"));

    expect(loadInlineKnowledge(kb)).toEqual([{ path: "faq.md", content: "Q&A" }]);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
