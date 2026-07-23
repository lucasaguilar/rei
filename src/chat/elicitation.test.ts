import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @clack so we can drive confirm/select without a real TTY. isCancel treats a symbol as cancel.
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: (v: unknown) => typeof v === "symbol",
}));
import { confirm, select, text } from "@clack/prompts";
import {
  nonInteractiveElicit,
  createClackElicit,
  newElicitationId,
  type Elicitation,
} from "./elicitation.js";

const confirmMock = confirm as unknown as ReturnType<typeof vi.fn>;
const selectMock = select as unknown as ReturnType<typeof vi.fn>;
const textMock = text as unknown as ReturnType<typeof vi.fn>;

const confirmReq: Elicitation = { id: "a", kind: "confirm", message: "edit?", default: "no" };
const selectReq: Elicitation = {
  id: "b",
  kind: "select",
  message: "which mode?",
  options: [
    { value: "agent", label: "Edit" },
    { value: "ask", label: "Explain" },
  ],
  default: "ask",
};

describe("nonInteractiveElicit", () => {
  it("resolves to the safe default for both kinds", async () => {
    expect(await nonInteractiveElicit(confirmReq)).toEqual({ id: "a", value: "no" });
    expect(await nonInteractiveElicit(selectReq)).toEqual({ id: "b", value: "ask" });
  });
});

describe("createClackElicit", () => {
  const elicit = createClackElicit();
  beforeEach(() => {
    confirmMock.mockReset();
    selectMock.mockReset();
    textMock.mockReset();
  });

  it("maps a confirm to yes/no", async () => {
    confirmMock.mockResolvedValueOnce(true);
    expect(await elicit(confirmReq)).toEqual({ id: "a", value: "yes" });
    confirmMock.mockResolvedValueOnce(false);
    expect(await elicit(confirmReq)).toEqual({ id: "a", value: "no" });
  });

  it("returns the chosen select value", async () => {
    selectMock.mockResolvedValueOnce("agent");
    expect(await elicit(selectReq)).toEqual({ id: "b", value: "agent" });
  });

  it("returns a free-form text answer", async () => {
    const textReq: Elicitation = { id: "t", kind: "text", message: "base url?", default: "" };
    textMock.mockResolvedValueOnce("https://api.example.com");
    expect(await elicit(textReq)).toEqual({ id: "t", value: "https://api.example.com" });
  });

  it("falls back to the safe default when the user cancels", async () => {
    confirmMock.mockResolvedValueOnce(Symbol("cancel"));
    expect(await elicit(confirmReq)).toEqual({ id: "a", value: "no" });
    selectMock.mockResolvedValueOnce(Symbol("cancel"));
    expect(await elicit(selectReq)).toEqual({ id: "b", value: "ask" });
  });

  it("resolves to default (without prompting) when a select has no options", async () => {
    const noOptions: Elicitation = { id: "c", kind: "select", message: "?", default: "x" };
    expect(await elicit(noOptions)).toEqual({ id: "c", value: "x" });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe("newElicitationId", () => {
  it("generates unique ids", () => {
    expect(newElicitationId()).not.toBe(newElicitationId());
  });
});
