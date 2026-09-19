import { describe, it, expect, afterEach } from "vitest";
import { isCyclicRepetition, isDegenerate, looksLooping } from "./loop-guard.js";

/**
 * The loop that prompted this, reproduced from a real 27B turn: it did not stutter a phrase, it
 * re-derived the same PARAGRAPH every few sentences, for 12,000 output tokens, until the turn
 * ended mid-word.
 */
const PARAGRAPH =
  "For the provider rename, I'm realizing the provider-factory file is mixing the rename with " +
  "new provider additions, which is tricky to split cleanly. The simplest approach is to keep " +
  "the rename and the new providers together in one commit for the provider-related changes, " +
  "even though it's not perfectly atomic. ";
const FILLER =
  "The gitignore change is trivial and self-contained. The deployment files are their own " +
  "cluster, and the docs updates are mostly rename-related, so I should group those with the " +
  "provider rename commit to avoid breaking the env workspace fallback. ";
/** Six laps ≈ 530 words — the real turn ran to 12,000 tokens before anything stopped it. */
const CYCLING = (PARAGRAPH + FILLER).repeat(6);

/** A long, legitimately repetitive answer: parallel structure, no cycle. */
const STRUCTURED = Array.from(
  { length: 40 },
  (_, i) =>
    `Criterion ${i + 1}: the command must exit non-zero when the workspace is missing, and the ` +
    `message must name the path it looked for, so the ${i + 1}th failure is diagnosable without a rerun.`,
).join(" ");

describe("isCyclicRepetition", () => {
  it("catches a paragraph the model keeps coming back to", () => {
    expect(isCyclicRepetition(CYCLING)).toBe(true);
  });

  it("is what catches it — the clustered check cannot see this shape", () => {
    // Not a criticism of isDegenerate: it is tuned for back-to-back stutter on purpose, and the
    // repeats here are sixty words apart. This documents WHY a second detector exists.
    expect(isDegenerate(CYCLING)).toBe(false);
    expect(looksLooping(CYCLING)).toBe(true);
  });

  it("leaves a long answer with parallel structure alone", () => {
    expect(isCyclicRepetition(STRUCTURED)).toBe(false);
    expect(looksLooping(STRUCTURED)).toBe(false);
  });

  it("does not fire below the length floor, however repetitive", () => {
    // A model that says the same thing three times in a paragraph is writing badly, not cycling,
    // and cutting its stream would cost more than it saves.
    expect(isCyclicRepetition((PARAGRAPH + FILLER).repeat(3))).toBe(false);
  });

  it("still catches the stutter it always caught", () => {
    expect(looksLooping("I will be. I will be. I will be. I will be. I will be. ".repeat(6))).toBe(
      true,
    );
  });
});

describe("the off switch", () => {
  const saved = process.env.REI_LOOP_GUARD;
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_LOOP_GUARD;
    else process.env.REI_LOOP_GUARD = saved;
  });

  it("stops flagging anything when REI_LOOP_GUARD=off", () => {
    // The escape hatch for the case this cannot get right on its own: a legitimately repetitive
    // answer. A guard that can stop a turn must be one the user can stop.
    process.env.REI_LOOP_GUARD = "off";
    expect(looksLooping(CYCLING)).toBe(false);
    expect(looksLooping("I will be. ".repeat(40))).toBe(false);
    // The detectors themselves still answer honestly — only the guard defers.
    expect(isCyclicRepetition(CYCLING)).toBe(true);
  });

  it("is on unless told otherwise", () => {
    delete process.env.REI_LOOP_GUARD;
    expect(looksLooping(CYCLING)).toBe(true);
  });
});
