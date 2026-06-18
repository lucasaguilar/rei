import { describe, expect, it, vi } from "vitest";
import type {
  ModelProvider,
  ChatCompletionWithTools,
  ToolDefinition,
} from "./model-provider.js";
import type { ChatMessage } from "../chat/types.js";
import type { ModelLifecycle } from "../contracts/execution-contract.js";
import { withTelemetry } from "./with-telemetry.js";
import { withDegenerateGuard } from "./degenerate-guard.js";

/** A provider that implements ModelProvider AND the optional ModelLifecycle. */
class LifecycleProvider implements ModelProvider, ModelLifecycle {
  loaded = "";
  async complete(prompt: string): Promise<string> {
    return `complete:${prompt}`;
  }
  async completeChat(messages: ChatMessage[]): Promise<string> {
    return `chat:${messages.length}`;
  }
  async *streamChat(): AsyncIterable<string> {
    yield "a";
    yield "b";
    yield "c";
  }
  async completeChatWithTools(
    _messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<ChatCompletionWithTools> {
    return {
      content: "ok",
      toolCalls: [],
      finishReason: "stop",
      reasoning: `tools:${tools.length}`,
    };
  }
  async loadModel(model: string): Promise<void> {
    this.loaded = model;
  }
  async unloadModel(_model: string): Promise<void> {
    this.loaded = "";
  }
  async isModelLoaded(model: string): Promise<boolean> {
    return this.loaded === model;
  }
  /** An arbitrary extra method that must survive the wrapper. */
  custom(x: number): number {
    return x * 2;
  }
}

const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("withTelemetry — C6 lifecycle forwarding", () => {
  it("still exposes loadModel/unloadModel/isModelLoaded after wrapping", () => {
    const wrapped = withTelemetry(new LifecycleProvider(), "mock") as ModelProvider &
      ModelLifecycle;
    expect(typeof wrapped.loadModel).toBe("function");
    expect(typeof wrapped.unloadModel).toBe("function");
    expect(typeof wrapped.isModelLoaded).toBe("function");
  });

  it("forwards load/unload/isModelLoaded to the underlying provider", async () => {
    const base = new LifecycleProvider();
    const wrapped = withTelemetry(base, "mock") as ModelProvider & ModelLifecycle;

    await wrapped.loadModel("llama");
    expect(base.loaded).toBe("llama");
    await expect(wrapped.isModelLoaded("llama")).resolves.toBe(true);
    await wrapped.unloadModel("llama");
    expect(base.loaded).toBe("");
    await expect(wrapped.isModelLoaded("llama")).resolves.toBe(false);
  });

  it("survives the full factory decorator chain (degenerate-guard + telemetry)", () => {
    const chained = withTelemetry(
      withDegenerateGuard(new LifecycleProvider()),
      "mock",
    ) as ModelProvider & ModelLifecycle;
    expect(typeof chained.loadModel).toBe("function");
    expect(typeof chained.unloadModel).toBe("function");
    expect(typeof chained.isModelLoaded).toBe("function");
  });
});

describe("withTelemetry — transparent passthrough", () => {
  it("complete / completeChat return the underlying value", async () => {
    const wrapped = withTelemetry(new LifecycleProvider(), "mock");
    await expect(wrapped.complete("yo")).resolves.toBe("complete:yo");
    await expect(wrapped.completeChat(msgs)).resolves.toBe("chat:1");
  });

  it("streamChat yields the same tokens in order", async () => {
    const wrapped = withTelemetry(new LifecycleProvider(), "mock");
    const out: string[] = [];
    for await (const t of wrapped.streamChat!(msgs)) out.push(t);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("streamChat invokes the underlying generator exactly once", async () => {
    const base = new LifecycleProvider();
    const spy = vi.spyOn(base, "streamChat");
    const wrapped = withTelemetry(base, "mock");
    const out: string[] = [];
    for await (const t of wrapped.streamChat!(msgs)) out.push(t);
    expect(out).toEqual(["a", "b", "c"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("completeChatWithTools returns the structured result", async () => {
    const wrapped = withTelemetry(new LifecycleProvider(), "mock");
    const tools: ToolDefinition[] = [];
    await expect(wrapped.completeChatWithTools!(msgs, tools)).resolves.toMatchObject({
      content: "ok",
      finishReason: "stop",
    });
  });

  it("forwards arbitrary extra methods unchanged", () => {
    const wrapped = withTelemetry(
      new LifecycleProvider(),
      "mock",
    ) as ModelProvider & { custom(x: number): number };
    expect(wrapped.custom(21)).toBe(42);
  });

  it("calls the underlying method exactly once per call", async () => {
    const base = new LifecycleProvider();
    const spy = vi.spyOn(base, "completeChat");
    const wrapped = withTelemetry(base, "mock");
    await wrapped.completeChat(msgs);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("withDegenerateGuard — C6 lifecycle forwarding", () => {
  it("still exposes the lifecycle methods after wrapping", () => {
    const wrapped = withDegenerateGuard(new LifecycleProvider()) as ModelProvider &
      ModelLifecycle;
    expect(typeof wrapped.loadModel).toBe("function");
    expect(typeof wrapped.unloadModel).toBe("function");
    expect(typeof wrapped.isModelLoaded).toBe("function");
  });
});
