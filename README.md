# rei

REI is a minimal personal AI agent CLI built with TypeScript and Node.js. It provides a simple, extensible foundation for running AI-powered tasks from the command line.

## Install dependencies

```bash
npm install
```

## Commands

### `plan` — one-shot task breakdown

```bash
npm run dev -- plan "create a worktree helper CLI"
```

Sends a single prompt to the model and prints the response.

### `chat` — interactive session

```bash
npm run dev -- chat
```

Starts a persistent conversation loop. Type any message and press Enter to get a response. The full conversation history is kept in memory for the duration of the session.

#### Chat internal commands

| Command  | Description                        |
|----------|------------------------------------|
| `/help`  | Show available commands            |
| `/clear` | Clear conversation history         |
| `/exit`  | End the session                    |

## Type check

```bash
npm run check
```

## Technical notes

### Design decisions

- **`ChatMessage` / `ChatSession` types** (`src/chat/types.ts`): A shared message structure with `role` (`system | user | assistant`) and `content` enables history-aware conversations and is compatible with standard LLM chat APIs.

- **`ModelProvider` interface** (`src/providers/model-provider.ts`): Extended with `completeChat(messages: ChatMessage[]): Promise<string>` alongside the existing `complete(prompt: string)`. The `complete` method is preserved so the `plan` command and any existing code keep working unchanged.

- **`Agent.runTurn`** (`src/core/agent.ts`): Appends the user message to the session, calls `completeChat`, and appends the assistant reply. All state lives in the `ChatSession` passed by the caller — the agent itself is stateless.

- **`MockProvider.completeChat`** (`src/providers/mock-provider.ts`): Echoes the last user message so the chat loop works without any real model.

### Adding an `OllamaProvider` later

Create a new class that implements `ModelProvider`:

```typescript
import type { ModelProvider } from "./model-provider.js";
import type { ChatMessage } from "../chat/types.js";

export class OllamaProvider implements ModelProvider {
  async complete(prompt: string): Promise<string> {
    return this.completeChat([{ role: "user", content: prompt }]);
  }

  async completeChat(messages: ChatMessage[]): Promise<string> {
    // POST to http://localhost:11434/api/chat with { model, messages }
    // and return response.message.content
    throw new Error("Not yet implemented");
  }
}
```

Then swap `MockProvider` for `OllamaProvider` in `run-cli.ts` — no other changes needed.
