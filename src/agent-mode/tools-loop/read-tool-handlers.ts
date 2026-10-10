import { handleReadFiles, type ReadFilesContext } from "./read-files-handler.js";
import { grepCode, listFiles } from "../../tools/code-search.js";
import { scopeReadCall } from "./read-scope.js";

/**
 * The three read tools — read_files, grep_code, list_files — as one dispatch step, with the turn's
 * read scope applied around them (see read-scope). Returns undefined for any other tool.
 *
 * Split out of dispatch-tool-calls when the MCP gate and the read scope, landing in the same file
 * from two branches, took it past its 400 lines.
 */
export async function runReadTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ReadFilesContext & { readRoot?: string },
): Promise<string | undefined> {
  if (name !== "read_files" && name !== "grep_code" && name !== "list_files") return undefined;
  // A multi-user channel reads only inside readRoot, never .rei/ (other people's sessions).
  const scoped = ctx.readRoot
    ? scopeReadCall(name, args, ctx.workspacePath, ctx.readRoot)
    : undefined;
  if (scoped?.refused) return scoped.refused;
  const result = await runUnscoped(name, args, ctx);
  return scoped ? scoped.finish(result) : result;
}

async function runUnscoped(
  name: string,
  args: Record<string, unknown>,
  ctx: ReadFilesContext,
): Promise<string> {
  const { workspacePath, emitStatus } = ctx;
  if (name === "read_files") {
    // No re-read guard: read_files always serves the file. If the model asks for it, it gets it.
    const rf = await handleReadFiles((args.paths as string[]) ?? [], ctx, {
      offset: args.offset as number | undefined,
      limit: args.limit as number | undefined,
    });
    return rf.text;
  }
  if (name === "grep_code") {
    emitStatus(`🔎  [REI] grep_code: ${(args.pattern as string) ?? ""}`);
    return grepCode(workspacePath, {
      pattern: (args.pattern as string) ?? "",
      path: args.path as string | undefined,
      glob: args.glob as string | undefined,
      maxResults: args.max_results as number | undefined,
    });
  }
  emitStatus(`📁  [REI] list_files: ${(args.glob as string) ?? "*"}`);
  return listFiles(workspacePath, {
    glob: args.glob as string | undefined,
    path: args.path as string | undefined,
    maxResults: args.max_results as number | undefined,
  });
}
