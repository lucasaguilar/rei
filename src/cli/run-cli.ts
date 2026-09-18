import * as fs from "fs";
import { setVerboseOutput } from "../config/output-verbosity.js";
import * as path from "path";
import { Agent } from "../core/agent.js";
import type { SessionMode } from "../chat/types.js";
import { createModelProvider } from "../providers/provider-factory.js";
import { runOneShot } from "./run-oneshot.js";
import { runChat } from "./run-chat.js";
import { getVersion } from "./version.js";
import { helpText } from "./help.js";

export async function runCli(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);

  // --help before everything: it must answer even when nothing is configured and no provider can
  // be built, which is exactly when someone types it.
  if (parsed.help) {
    console.log(helpText());
    process.exit(0);
  }

  // --version is a zero-dependency shortcut: prints version and exits before anything else
  if (parsed.version) {
    console.log(`rei ${getVersion()}`);
    process.exit(0);
  }

  const command =
    parsed.command ?? (parsed.workspaceInput ? "chat" : undefined);
  const rest = parsed.commandArgs;

  if (!command) {
    console.error("Usage: rei [--workspace <path>] <command>");
    console.error("Available commands: ask, plan, agent, chat — see `rei --help`.");
    process.exit(1);
  }

  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(parsed.workspaceInput);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // `--verbose` applies to the interactive session too, not just the one-shots: it is the same
  // question either way — show the machinery, or only what it produced.
  if (parsed.verbose) setVerboseOutput(true);

  const provider = createModelProvider();
  const agent = new Agent(provider, workspacePath);

  // Connect configured MCP servers before handling any command so their tools
  // are available in every mode. Best-effort: per-server failures are already
  // swallowed by the registry, and a bad config must not block startup.
  try {
    await agent.connectMcp();
  } catch (error) {
    console.error(
      `⚠️  MCP startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    // One-shot modes. They run the REAL turn pipeline (system prompt, repo context, tools, skills),
    // unlike the old `plan`, which called provider.complete() directly and so measured the bare
    // model rather than REI.
    const ONE_SHOT: Record<string, SessionMode> = {
      ask: "ask",
      plan: "planning",
      agent: "agent",
    };
    if (command in ONE_SHOT) {
      const task = rest.join(" ");
      if (!task) {
        console.error(`Usage: rei [--workspace <path>] ${command} "<prompt>"`);
        process.exit(1);
      }
      await runOneShot(agent, workspacePath, ONE_SHOT[command], task, {
        metrics: parsed.metrics,
        verbose: parsed.verbose,
      });
      return;
    }

    if (command === "chat") {
      const autoIndex = !parsed.noAutoIndex;
      await runChat(agent, workspacePath, autoIndex, {
        name: parsed.sessionName,
        continue: parsed.continueSession,
        force: parsed.forceSession,
      });
      return;
    }

    console.error(`Unknown command: ${command}`);
    console.error("Available commands: ask, plan, agent, chat — see `rei --help`.");
    process.exit(1);
  } finally {
    await agent.disposeMcp();
  }
}

function parseCliArgs(args: string[]): {
  workspaceInput?: string;
  command?: string;
  commandArgs: string[];
  noAutoIndex: boolean;
  version: boolean;
  metrics: boolean;
  verbose: boolean;
  sessionName?: string;
  continueSession: boolean;
  forceSession: boolean;
  help: boolean;
} {
  const positional: string[] = [];
  let workspaceInput: string | undefined;
  let noAutoIndex = false;
  let version = false;
  let metrics = false;
  let verbose = false;
  let sessionName: string | undefined;
  let continueSession = false;
  let forceSession = false;
  let help = false;

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

    // --session/-s <name>: bind this terminal to a named session (multi-session). See multi-session-spec.
    if (arg === "--session" || arg === "-s") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("Missing value for --session");
        process.exit(1);
      }
      sessionName = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--session=")) {
      const value = arg.slice("--session=".length).trim();
      if (!value) {
        console.error("Missing value for --session");
        process.exit(1);
      }
      sessionName = value;
      continue;
    }

    // --continue/-c: resume the most recent session instead of starting fresh.
    if (arg === "--continue" || arg === "-c") {
      continueSession = true;
      continue;
    }

    // --force: steal a session lock held by another (or a stale) instance.
    if (arg === "--force") {
      forceSession = true;
      continue;
    }

    if (arg === "--no-auto-index") {
      noAutoIndex = true;
      continue;
    }

    if (arg === "--help" || arg === "-h" || arg === "help") {
      help = true;
      continue;
    }
    if (arg === "--version") {
      version = true;
      continue;
    }

    // Metrics go to stderr so stdout stays pure content — that split is what makes a one-shot run
    // scriptable for A/B comparison against another agent.
    if (arg === "--metrics") {
      metrics = true;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    positional.push(arg);
  }

  return {
    workspaceInput,
    command: positional[0],
    commandArgs: positional.slice(1),
    noAutoIndex,
    version,
    metrics,
    verbose,
    sessionName,
    continueSession,
    forceSession,
    help,
  };
}

/**
 * `--workspace <path>` → `REI_WORKSPACE_PATH` → cwd, the same order `load-env.ts` uses to decide
 * WHICH `.env` to read. Skipping the env var here split the two: the wizard's variable picked the
 * config while the agent wrote into whatever directory it was launched from — which is how a
 * one-shot run aimed at a temp workspace ended up creating files inside this repo.
 */
export function resolveWorkspacePath(workspaceInput?: string): string {
  const resolvedPath = path.resolve(
    workspaceInput ?? process.env.REI_WORKSPACE_PATH ?? process.cwd(),
  );

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
