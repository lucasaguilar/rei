import type { TurnStatus } from "../../core/models/agent.types.js";
import { renderMarkdown } from "../markdown-renderer.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";

export async function handleInputTurn(
  trimmed: string,
  ctx: InputHandlerContext,
): Promise<void> {
  const { state, agent, session, transcript, actions } = ctx;

  state.busy = true;
  state.activeStatus = "building_context";
  state.spinnerIndex = 0;
  actions.startSpinner();
  actions.draw();

  try {
    let lastStatus: TurnStatus | undefined;
    let buffer = "";
    let liveStart = -1;

    for await (const token of agent.streamTurn(session, trimmed, {
      onStatus: (status) => {
        if (lastStatus === status) return;
        lastStatus = status;
        state.activeStatus = status;

        if (status === "producing_response" && liveStart < 0) {
          actions.pushTranscript("");
          actions.pushTranscript(`\x1b[1;36mYou: ${trimmed}\x1b[0m`);
          actions.pushTranscript("");
          actions.draw();
          liveStart = transcript.length;
          transcript.push("");
        }
      },
    })) {
      buffer += token;
      if (liveStart >= 0) {
        const lines = buffer.split("\n");
        transcript.splice(liveStart, transcript.length - liveStart, ...lines);
      }
    }

    if (liveStart >= 0) {
      const rendered = renderMarkdown(buffer);
      const lines = rendered.split("\n");
      transcript.splice(liveStart, transcript.length - liveStart, ...lines);
    } else {
      actions.pushTranscript("");
      actions.pushTranscript(`You: ${trimmed}`);
      actions.pushTranscript("");
      actions.pushTranscript(renderMarkdown(buffer));
    }
    actions.pushTranscript("");
  } catch (err: unknown) {
    actions.pushTranscript(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    state.busy = false;
    state.activeStatus = undefined;
    actions.stopSpinner();
    actions.draw();
  }
}
