import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isSpecMessage,
  saveSpecToFile,
  loadSpecFromFile,
} from "./spec-tracker.js";

const SAMPLE_SPEC = `# Spec: Show API config

## Goal
Display the API URLs and cache durations.

## In scope
- A read-only settings page.

## Out of scope (non-goals)
- No editing, no persistence.

## Acceptance criteria
1. The page lists each API URL.

## Constraints
- Angular standalone + OnPush.

## Open questions
- None.
`;

describe("isSpecMessage", () => {
  it("recognizes a spec by its '# Spec:' heading", () => {
    expect(isSpecMessage(SAMPLE_SPEC)).toBe(true);
  });

  it("recognizes a spec by its acceptance-criteria section even without the heading", () => {
    expect(
      isSpecMessage("## Acceptance criteria\n1. It works."),
    ).toBe(true);
  });

  it("does not mistake a plain plan or prose for a spec", () => {
    expect(isSpecMessage("## Stage 1: Do a thing\nFiles to modify: a.ts")).toBe(
      false,
    );
    expect(isSpecMessage("just some notes about the code")).toBe(false);
  });
});

describe("saveSpecToFile / loadSpecFromFile", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rei-spec-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("round-trips a spec through .rei/specs/<name>.md", () => {
    const saved = saveSpecToFile(workspace, "show-config", SAMPLE_SPEC);
    expect(saved).toBe(
      path.join(workspace, ".rei", "specs", "show-config.md"),
    );
    expect(fs.existsSync(saved)).toBe(true);
    expect(loadSpecFromFile(workspace, "show-config")).toBe(SAMPLE_SPEC);
  });

  it("sanitizes the name to prevent path traversal", () => {
    const saved = saveSpecToFile(workspace, "../../evil", SAMPLE_SPEC);
    expect(saved.startsWith(path.join(workspace, ".rei", "specs"))).toBe(true);
    expect(saved).not.toContain("..");
  });

  it("throws a clear error when the spec file is missing", () => {
    expect(() => loadSpecFromFile(workspace, "nope")).toThrow(
      /Spec file not found/,
    );
  });
});
