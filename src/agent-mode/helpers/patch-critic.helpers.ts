import type { ChatSession } from "../../chat/types.js";
import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import type { AgentLogger } from "../../core/logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { FileMeta } from "../../workspace/workspace-scanner.js";
import type { PatchProposalValidationResult } from "../../tools/patch-validator.js";
import type { AstValidationOptions } from "../../tools/typescript-ast-validator.js";
import { canonicalizePathAgainstScannedFiles } from "./decision-path.helpers.js";
import type {
  PatchValidationEntry,
  SearchReplaceBlock,
} from "../models/patch.types.js";
import {
  buildPatchesFromEdits,
  parseSearchReplacePayload,
} from "./patch-repair.helpers.js";

export async function runPatchCriticLoop(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
  patchValidation: PatchValidationEntry[];
  logger: AgentLogger;
  retryableCodes: Set<string>;
  retryLimit: number;
  normalizePatch: (patch: string, expectedFile: string) => string;
  validateProposal: (
    proposal: AgentProposedPatch,
    workspacePath: string,
    logger?: AgentLogger,
    astOptions?: AstValidationOptions,
  ) => Promise<PatchProposalValidationResult>;
  astOptions?: AstValidationOptions;
}): Promise<PatchValidationEntry[]> {
  const {
    provider,
    messagesForModel,
    workspacePath,
    scannedFiles,
    patchValidation,
    logger,
    retryableCodes,
    retryLimit,
    normalizePatch,
    validateProposal,
    astOptions,
  } = params;
  const result = [...patchValidation];

  for (let i = 0; i < result.length; i += 1) {
    const item = result[i];
    if (item.validation.valid) continue;

    const retryableIssues = item.validation.issues.filter((issue) =>
      retryableCodes.has(issue.code),
    );
    if (retryableIssues.length === 0) continue;

    const criticMessages: ChatSession["messages"] = [
      ...messagesForModel,
      {
        role: "user",
        content: [
          `The patch for "${item.proposal.file}" failed validation:`,
          retryableIssues
            .map((issue) => `- ${issue.code}: ${issue.message}`)
            .join("\n"),
          "",
          "Instead of a raw diff, return an edit as JSON:",
          '{"file":"...","description":"...","search":"exact lines to find in the file","replace":"replacement lines"}',
          "or for file creation:",
          '{"file":"src/new-file.ts","description":"...","create":true,"content":"full file content"}',
          "",
          "Rules:",
          '- For existing files, "search" must be an exact substring of the file content.',
          '- For new files, use create=true and provide full "content".',
          "- Include 2-3 context lines to uniquely identify the location.",
          "- Do not add prose. First char must be {.",
        ].join("\n"),
      },
    ];

    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
      const raw = await provider.completeChat(criticMessages);
      const parsed = parseSearchReplacePayload(raw);

      if (!parsed || typeof parsed.file !== "string") continue;

      const file = canonicalizePathAgainstScannedFiles(
        (parsed.file as string) || item.proposal.file,
        scannedFiles,
      );
      const description =
        typeof parsed.description === "string"
          ? parsed.description
          : item.proposal.description;

      if (
        typeof parsed.search === "string" &&
        typeof parsed.replace === "string"
      ) {
        const edits: SearchReplaceBlock[] = [
          {
            file,
            description,
            search: parsed.search as string,
            replace: parsed.replace as string,
          },
        ];

        const patches = await buildPatchesFromEdits(edits, workspacePath);
        if (patches.length > 0) {
          const validation = await validateProposal(
            patches[0],
            workspacePath,
            logger,
            astOptions,
          );
          if (validation.valid) {
            result[i] = { proposal: patches[0], validation };
            break;
          }

          item.validation = validation;
        }
      }

      if (parsed.create === true && typeof parsed.content === "string") {
        const edits: SearchReplaceBlock[] = [
          {
            file,
            description,
            search: "",
            replace: "",
            create: true,
            content: parsed.content,
          },
        ];

        const patches = await buildPatchesFromEdits(edits, workspacePath);
        if (patches.length > 0) {
          const validation = await validateProposal(
            patches[0],
            workspacePath,
            logger,
            astOptions,
          );
          if (validation.valid) {
            result[i] = { proposal: patches[0], validation };
            break;
          }

          item.validation = validation;
        }
      }

      if (typeof parsed.patch === "string") {
        const corrected: AgentProposedPatch = {
          file,
          patch: normalizePatch(parsed.patch as string, file),
          description,
        };
        const validation = await validateProposal(
          corrected,
          workspacePath,
          logger,
          astOptions,
        );
        if (validation.valid) {
          result[i] = { proposal: corrected, validation };
          break;
        }

        item.validation = validation;
      }

      if (attempt < retryLimit - 1) {
        criticMessages.push(
          { role: "assistant", content: raw },
          {
            role: "user",
            content: [
              "That edit could not be applied.",
              'For existing files, make sure the "search" field is an exact copy of lines from the file.',
              'For new files, use {"create":true,"content":"..."}.',
              "Return the corrected JSON object.",
            ].join("\n"),
          },
        );
      }
    }
  }

  return result;
}
