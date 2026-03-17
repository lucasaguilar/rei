import { Agent } from "../core/agent.js";
import { MockProvider } from "../providers/mock-provider.js";
import { planningSkill } from "../skills/planning-skill.js";
import { runChat } from "./run-chat.js";

export async function runCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;

  if (!command) {
    console.error("Usage: rei <command>");
    console.error("Available commands: plan, chat");
    process.exit(1);
  }

  const provider = new MockProvider();
  const agent = new Agent(provider);

  if (command === "plan") {
    const task = rest.join(" ");
    if (!task) {
      console.error("Usage: rei plan \"<task description>\"");
      process.exit(1);
    }
    const result = await planningSkill(agent, task);
    console.log(result);
    return;
  }

  if (command === "chat") {
    await runChat(agent);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Available commands: plan, chat");
  process.exit(1);
}
