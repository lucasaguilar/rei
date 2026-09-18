import { describe, it, expect, vi } from "vitest";
import { withDegenerateGuard } from "./degenerate-guard.js";
import type {
  ChatCompletionWithTools,
  ModelProvider,
  ToolStreamDelta,
  ToolStreamVerdict,
} from "./model-provider.js";

const PARAGRAPH =
  "For the provider rename, I'm realizing the provider-factory file is mixing the rename with " +
  "new provider additions, which is tricky to split cleanly. The simplest approach is to keep " +
  "the rename and the new providers together in one commit for the provider-related changes, " +
  "even though it's not perfectly atomic. ";
const FILLER =
  "The gitignore change is trivial and self-contained. The deployment files are their own " +
  "cluster, and the docs updates are mostly rename-related, so I should group those with the " +
  "provider rename commit to avoid breaking the env workspace fallback. ";

/** A provider that streams `chunks` until a consumer says stop — like the real SSE loop. */
function fakeProvider(chunks: string[], type: ToolStreamDelta["type"] = "reasoning") {
  const sent: string[] = [];
  const provider = {
    complete: vi.fn(),
    completeChat: vi.fn(),
    streamChatWithTools: vi.fn(
      async (
        _m: unknown,
        _t: unknown,
        onDelta: (d: ToolStreamDelta) => ToolStreamVerdict,
      ): Promise<ChatCompletionWithTools> => {
        for (const content of chunks) {
          sent.push(content);
          if (onDelta({ type, content }) === "stop") {
            return {
              content: sent.join(""),
              toolCalls: [],
              finishReason: "stop",
              stoppedEarly: "repetition",
            };
          }
        }
        return { content: sent.join(""), toolCalls: [], finishReason: "stop" };
      },
    ),
  } as unknown as ModelProvider;
  return { provider, sent };
}

/**
 * The guard used to forward this path untouched, which made it dead code exactly where it was
 * needed: since the native unification EVERY agent turn streams through `streamChatWithTools`.
 * A 27B cycling through two paragraphs ran to 12,000 output tokens with nothing watching.
 */
describe("the loop guard on the tools streaming path", () => {
  it("stops a model that keeps cycling through the same block", async () => {
    const laps = Array.from({ length: 12 }, () => PARAGRAPH + FILLER);
    const { provider, sent } = fakeProvider(laps);
    const guarded = withDegenerateGuard(provider);

    const result = await guarded.streamChatWithTools!([], [], () => {});

    expect(result.stoppedEarly).toBe("repetition");
    expect(sent.length).toBeLessThan(laps.length); // cut before the model finished looping
  });

  it("watches the REASONING too, where this loop actually lived", async () => {
    // `content` stayed empty for the whole runaway generation; everything was in reasoning.
    const laps = Array.from({ length: 12 }, () => PARAGRAPH + FILLER);
    const { provider, sent } = fakeProvider(laps, "reasoning");
    await withDegenerateGuard(provider).streamChatWithTools!([], [], () => {});
    expect(sent.length).toBeLessThan(laps.length);
  });

  it("does not touch a long answer that is merely long", async () => {
    const prose = Array.from(
      { length: 30 },
      (_, i) =>
        `Step ${i + 1}: read the ${i + 1}th diff, decide whether it belongs with the rename or ` +
        `with the deployment cluster, and write the commit message before moving on. `,
    );
    const { provider, sent } = fakeProvider(prose);
    const result = await withDegenerateGuard(provider).streamChatWithTools!([], [], () => {});

    expect(result.stoppedEarly).toBeUndefined();
    expect(sent).toHaveLength(prose.length);
  });

  it("still delivers every delta to the real consumer while it watches", async () => {
    const { provider } = fakeProvider(["hola ", "que ", "tal"]);
    const seen: string[] = [];
    await withDegenerateGuard(provider).streamChatWithTools!([], [], (d) => {
      seen.push(d.content);
    });
    expect(seen.join("")).toBe("hola que tal");
  });
});
