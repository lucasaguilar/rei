import * as fs from "fs";
import * as path from "path";
import { Agent } from "../core/agent.js";
import { createModelProvider } from "../providers/provider-factory.js";
import { planningSkill } from "../skills/planning-skill.js";
import { runChat } from "./run-chat.js";

export async function runCli(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);

  const command = parsed.command ?? (parsed.workspaceInput ? "chat" : undefined);
  const rest = parsed.commandArgs;

  if (!command) {
    console.error("Usage: rei [--workspace <path>] <command>");
    console.error("Available commands: plan, chat");
    process.exit(1);
  }

  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(parsed.workspaceInput);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const provider = createModelProvider();
  const agent = new Agent(provider, workspacePath);

  if (command === "plan") {
    const task = rest.join(" ");
    if (!task) {
      console.error("Usage: rei [--workspace <path>] plan \"<task description>\"");
      process.exit(1);
    }
    const result = await planningSkill(agent, task);
    console.log(result);
    return;
  }

  if (command === "chat") {
    const autoIndex = !parsed.noAutoIndex;
    await runChat(agent, workspacePath, autoIndex);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Available commands: plan, chat");
  process.exit(1);
}

function parseCliArgs(args: string[]): {
  workspaceInput?: string;
  command?: string;
  commandArgs: string[];
  noAutoIndex: boolean;
} {
  const positional: string[] = [];
  let workspaceInput: string | undefined;
  let noAutoIndex = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--workspace") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("Missing value for --workspace");
        process.exit(1);
      }
      workspaceInput = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length).trim();
      if (!value) {
        console.error("Missing value for --workspace");
        process.exit(1);
      }
      workspaceInput = value;
      continue;
    }

    if (arg === "--no-auto-index") {
      noAutoIndex = true;
      continue;
    }

    positional.push(arg);
  }

  return {
    workspaceInput,
    command: positional[0],
    commandArgs: positional.slice(1),
    noAutoIndex,
  };
}

function resolveWorkspacePath(workspaceInput?: string): string {
  const resolvedPath = path.resolve(workspaceInput ?? process.cwd());

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    throw new Error(`Workspace path does not exist: ${resolvedPath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}
