import type { ChatSession } from "../../chat/types.js";

export function appendContextToLastUserMessage(
  messages: ChatSession["messages"],
  contextAddendum: string,
): ChatSession["messages"] {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].role === "user") {
      result[i] = {
        ...result[i],
        content: result[i].content + "\n\n" + contextAddendum,
      };
      return result;
    }
  }
  return result;
}
