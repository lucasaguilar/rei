import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The turn handler persists the session and may reach for a vision model; neither is what these
// tests are about, so both are stubbed out.
vi.mock("../../chat/session-store.js", () => ({ saveSession: vi.fn() }));
vi.mock("../vision-sidecar.js", () => ({ describeAttachedImages: vi.fn(async () => null) }));

import { handleInputTurn } from "./input-turn.helpers.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";

const THINKING = "\x10";
const TEXT = "\x11";

/** Drives one turn over a scripted chunk stream and reports what reached each surface. */
async function runTurn(chunks: string[]) {
  const streamed: string[] = [];
  const transcript: string[] = [];

  const ctx = {
    state: {},
    session: { messages: [] },
    transcript,
    workspacePath: "/tmp",
    agent: {
      // eslint-disable-next-line require-yield
      async *streamTurn() {
        for (const c of chunks) yield c;
      },
    },
    actions: {
      pushTranscript: (v: string) => transcript.push(v),
      streamText: (v: string) => streamed.push(v),
      draw: () => {},
      startSpinner: () => {},
      stopSpinner: () => {},
      resetInput: () => {},
      rememberHistory: () => {},
      getActivePalette: () => ({}),
      getMentionContext: () => undefined,
    },
  } as unknown as InputHandlerContext;

  await handleInputTurn("pregunta", ctx);

  // The rendered answer is the entry carrying the REI badge.
  const answer = transcript.find((l) => l.includes(" REI ")) ?? "";
  // eslint-disable-next-line no-control-regex
  return { live: streamed.join(""), answer: answer.replace(/\x1b\[[0-9;]*m/g, "") };
}

beforeEach(() => vi.clearAllMocks());

describe("what the final markdown render receives", () => {
  it("keeps live-shown command output out of the rendered answer when chunks interleave", async () => {
    // The regression: live status and buffered text arrive interleaved, so the old code — which
    // subtracted a CONCATENATION of the live chunks from the buffer — matched nothing and leaked
    // the command output into the render.
    const { live, answer } = await runTurn([
      "   ↳ exit 0\n-  const old = 1;\n+  const nuevo = 2;\n",
      `${TEXT}Listo, `,
      "   ↳ exit 0\nsegundo comando\n",
      `${TEXT}cambié una línea.`,
    ]);

    expect(live).toContain("↳ exit 0");
    expect(live).toContain("segundo comando");

    expect(answer).toContain("cambié una línea");
    expect(answer).not.toContain("↳ exit 0");
    expect(answer).not.toContain("segundo comando");
  });

  it("does not turn diff markers into bullets, because the diff never reaches the renderer", async () => {
    // Two status blocks split by text: a lone contiguous block was the one case the old
    // subtraction handled, so the second diff is the one that actually leaked.
    const { answer } = await runTurn([
      "   ↳ exit 0\nprimer comando\n",
      `${TEXT}Reviso el archivo. `,
      "   ↳ exit 0\n-  borrado\n+  agregado\n",
      `${TEXT}Ya está.`,
    ]);

    // `-` and `+` are both valid markdown bullet markers: had the diff reached renderMarkdown it
    // would come back as "*" for BOTH, erasing the added/removed distinction.
    expect(answer).not.toContain("* borrado");
    expect(answer).not.toContain("* agregado");
    expect(answer).toContain("Ya está");
  });

  it("still excludes thinking from the rendered answer", async () => {
    const { answer } = await runTurn([
      `${THINKING}razonando en voz alta`,
      `${TEXT}La respuesta.`,
    ]);

    expect(answer).not.toContain("razonando en voz alta");
    expect(answer).toContain("La respuesta");
  });
});

/**
 * With REI_VERBOSE the reasoning streams to the screen — and it came out shredded:
 *
 *     server is already configured:  thinking · 46s
 *     in rei.config.json — just      thinking · 46s
 *     use it")
 *
 * The spinner is re-armed after every tool call, and the guard that stopped it was
 * `if (!liveContentShown)` — true only for the FIRST live token of the turn. Every later block of
 * reasoning therefore streamed while the spinner was drawing, and its status line redrew between
 * fragments, landing in the middle of the sentences.
 */
async function spinnerTimeline(chunks: string[]) {
  const events: string[] = [];
  const ctx = {
    state: {},
    session: { messages: [] },
    transcript: [] as string[],
    workspacePath: "/tmp",
    agent: {
      // eslint-disable-next-line require-yield
      async *streamTurn() {
        for (const c of chunks) yield c;
      },
    },
    actions: {
      pushTranscript: () => {},
      // Reasoning is streamed dim+italic; that escape is how we spot it here.
      streamText: (v: string) => events.push(v.includes("\x1b[3;2m") ? "THINKING" : "text"),
      draw: () => {},
      startSpinner: () => events.push("start"),
      stopSpinner: () => events.push("stop"),
      resetInput: () => {},
      rememberHistory: () => {},
      getActivePalette: () => ({}),
      getMentionContext: () => undefined,
    },
  } as unknown as InputHandlerContext;
  await handleInputTurn("pregunta", ctx);
  return events;
}

describe("streaming the reasoning with REI_VERBOSE", () => {
  const saved = process.env.REI_VERBOSE;
  beforeEach(() => {
    process.env.REI_VERBOSE = "true";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_VERBOSE;
    else process.env.REI_VERBOSE = saved;
  });

  it("never prints reasoning while the spinner is drawing", async () => {
    const events = await spinnerTimeline([
      `${THINKING}primer bloque de razonamiento`,
      "   ↳ exit 0\nsalida de una herramienta\n", // a tool result re-arms the spinner
      `${THINKING}segundo bloque, despues de la herramienta`,
      `${THINKING} y sigue`,
      `${TEXT}listo`,
    ]);

    let running = true; // the spinner is started before the stream begins
    for (const e of events) {
      if (e === "start") running = true;
      else if (e === "stop") running = false;
      else if (e === "THINKING") {
        expect(running, `reasoning printed while the spinner was drawing: ${events.join(" → ")}`).toBe(
          false,
        );
      }
    }
  });

  it("still shows the reasoning — the fix is not 'print nothing'", async () => {
    const events = await spinnerTimeline([
      `${THINKING}razonando`,
      "   ↳ exit 0\n",
      `${THINKING}razonando otra vez`,
    ]);
    expect(events.filter((e) => e === "THINKING").length).toBeGreaterThanOrEqual(2);
  });
});
