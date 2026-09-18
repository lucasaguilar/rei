import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isReasoningShown,
  isVerboseOutput,
  setShowReasoning,
  setVerboseOutput,
} from "./output-verbosity.js";

/**
 * The reasoning used to ride along with REI_VERBOSE, so seeing the thinking meant also taking
 * twenty lines of output per command and a full diff per edit. They are separate questions: the
 * thinking is the sign of life on a local model, the rest is the noise. These lock the split.
 */
const savedVerbose = process.env.REI_VERBOSE;
const savedReasoning = process.env.REI_SHOW_REASONING;

beforeEach(() => {
  delete process.env.REI_VERBOSE;
  delete process.env.REI_SHOW_REASONING;
  setVerboseOutput(undefined);
  setShowReasoning(undefined);
});

afterEach(() => {
  setVerboseOutput(undefined);
  setShowReasoning(undefined);
  if (savedVerbose === undefined) delete process.env.REI_VERBOSE;
  else process.env.REI_VERBOSE = savedVerbose;
  if (savedReasoning === undefined) delete process.env.REI_SHOW_REASONING;
  else process.env.REI_SHOW_REASONING = savedReasoning;
});

describe("the defaults", () => {
  it("shows the reasoning and stays quiet about everything else", () => {
    expect(isReasoningShown()).toBe(true);
    expect(isVerboseOutput()).toBe(false);
  });
});

describe("REI_SHOW_REASONING", () => {
  it("turns the stream off for the falsey spellings", () => {
    for (const value of ["false", "0", "off", "no", "FALSE", " false "]) {
      process.env.REI_SHOW_REASONING = value;
      expect(isReasoningShown(), value).toBe(false);
    }
  });

  it("leaves it on for anything else, including true", () => {
    for (const value of ["true", "1", "", "yes"]) {
      process.env.REI_SHOW_REASONING = value;
      expect(isReasoningShown(), value).toBe(true);
    }
  });

  it("does not drag the command output and diffs along with it", () => {
    process.env.REI_SHOW_REASONING = "true";
    expect(isVerboseOutput()).toBe(false);
  });
});

describe("how the two switches interact", () => {
  it("verbose implies the reasoning", () => {
    process.env.REI_SHOW_REASONING = "false";
    setVerboseOutput(true);
    expect(isReasoningShown()).toBe(true);
  });

  it("does not revoke a reasoning the user asked for when verbose goes off", () => {
    setShowReasoning(true);
    setVerboseOutput(false);
    expect(isReasoningShown()).toBe(true);
  });

  it("lets /reasoning off win over the environment and over verbose", () => {
    process.env.REI_VERBOSE = "true";
    setShowReasoning(false);
    expect(isReasoningShown()).toBe(false);
    expect(isVerboseOutput()).toBe(true);
  });
});
