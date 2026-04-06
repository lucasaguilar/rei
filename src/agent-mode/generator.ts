import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import {
  parseAgentDecision,
  type AgentProposedPatch,
} from "../contracts/agent-decision.types.js";
import { resolveContextRequests } from "./context-resolution.js";
import { type PatchProposalValidationResult } from "../tools/patch-validator.js";
import type { AstValidationOptions } from "../tools/typescript-ast-validator.js";
import { extractAstDependencies } from "../context/ast-context.js";
import type { AgentLogger } from "../core/logger.js";
import {
  DECISION_RETRIES,
  PATCH_CRITIC_RETRIES,
  RETRYABLE_PATCH_CODES,
  SANDBOX_REPAIR_RETRIES,
} from "./constants/generator.constants.js";
import { extractProvidedContextPaths } from "./helpers/decision-path.helpers.js";
import { runDecisionPhase } from "./helpers/decision-phase.helpers.js";
import { appendContextToLastUserMessage } from "./helpers/context-message.helpers.js";
import { validateWithAstGuard } from "./helpers/patch-semantic-validation.helpers.js";
import { synthesizePatchesFromContext } from "./helpers/patch-repair.helpers.js";
import { runPatchCriticLoop } from "./helpers/patch-critic.helpers.js";
import { verifyPatchBatchInSandbox } from "./helpers/sandbox-verification.helpers.js";
import {
  appendPatchSection,
  normalizePatch,
  validateDecisionProposedPatches,
} from "./helpers/patch-validation.helpers.js";
import type {
  AgentContextPrelude,
  AgentModeOutcome,
} from "./models/generator.types.js";

export async function prepareAgentContext(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
  logger: AgentLogger;
}): Promise<AgentContextPrelude> {
  const { provider, messagesForModel, workspacePath, scannedFiles, logger } =
    params;
  const lastUserMessage = [...messagesForModel]
    .reverse()
    .find((m) => m.role === "user");

  // --- Phase 1: Context Decision ---
  let decision = await runDecisionPhase({
    provider,
    messagesForModel,
    logger,
    retryLimit: DECISION_RETRIES,
    parseAgentDecision,
  });

  // --- Phase 2: Context Resolution ---
  let answerMessages = messagesForModel;
  const resolvedFiles = new Set<string>();

  // Any files already embedded in the prompt context from Phase 0
  const providedPaths = extractProvidedContextPaths(
    lastUserMessage?.content ?? "",
  );
  for (const p of providedPaths) resolvedFiles.add(p);

  if (decision.contextRequests.length > 0) {
    const alreadyResolved = new Set<string>();
    const { contextMessage, resolvedPaths } = await resolveContextRequests(
      decision.contextRequests,
      workspacePath,
      alreadyResolved,
      scannedFiles,
    );
    if (resolvedPaths.length > 0 && contextMessage) {
      answerMessages = appendContextToLastUserMessage(
        messagesForModel,
        contextMessage,
      );
      for (const resolvedPath of resolvedPaths) {
        resolvedFiles.add(resolvedPath);
      }
    }
  }

  // --- Phase 2.0.1: Decision re-run after context injection ---
  // When the first decision said ready=false with no patches, the model was asking
  // for context. Now that context is injected, re-run the decision so the model can
  // produce patches with the enriched messages instead of falling through to synthesis.
  if (
    !decision.ready &&
    (decision.proposedPatches?.length ?? 0) === 0 &&
    resolvedFiles.size > providedPaths.size
  ) {
    const redecision = await runDecisionPhase({
      provider,
      messagesForModel: answerMessages,
      logger,
      retryLimit: DECISION_RETRIES,
      parseAgentDecision,
    });
    // Only adopt the new decision if it produced patches
    if ((redecision.proposedPatches?.length ?? 0) > 0) {
      decision = redecision;
    }
    // Also resolve any NEW context requests from the second pass
    if (redecision.contextRequests.length > 0) {
      const alreadyResolved2 = new Set(resolvedFiles);
      const { contextMessage: ctx2, resolvedPaths: rp2 } =
        await resolveContextRequests(
          redecision.contextRequests,
          workspacePath,
          alreadyResolved2,
          scannedFiles,
        );
      if (rp2.length > 0 && ctx2) {
        answerMessages = appendContextToLastUserMessage(answerMessages, ctx2);
        for (const resolvedPath of rp2) {
          resolvedFiles.add(resolvedPath);
        }
      }
    }
  }

  // --- Phase 2.1: Semantic AST Extraction (Graphing dependencies) ---
  const uniqueFilesToScrape = Array.from(resolvedFiles);
  if (uniqueFilesToScrape.length > 0) {
    const astContext = await extractAstDependencies(
      workspacePath,
      uniqueFilesToScrape,
    );
    if (astContext.text) {
      logger.logAstContext(
        astContext.filesScraped,
        astContext.dependenciesFound,
        astContext.text.length,
      );
      const astMessage = [
        "### AST Dependency Graph",
        "These are the exact skeletal signatures of the workspace dependencies imported by the files in your context.",
        "Always use these actual valid signatures when calling imported methods or creating objects.",
        "```typescript",
        astContext.text,
        "```",
      ].join("\n");
      answerMessages = appendContextToLastUserMessage(
        answerMessages,
        astMessage,
      );
    }
  }

  // --- Phase 2.5: Patch Validation ---
  let synthesisCoverage = undefined;
  let sandboxVerification = undefined;
  let patchValidation = await validateDecisionProposedPatches({
    decision,
    workspacePath,
    scannedFiles,
    logger,
    validateProposal: validateWithAstGuard,
  });

  // Collect create targets for the critic loops to suppress TS2307 on sibling new files
  const astOptions = buildAstOptionsFromProposals(
    decision.proposedPatches ?? [],
  );

  // 2.5.a: Critic loop — intenta corregir patches inválidos con códigos reintentables
  if (
    decision.taskType === "change-planning" &&
    patchValidation.some((item) => !item.validation.valid)
  ) {
    patchValidation = await runPatchCriticLoop({
      provider,
      messagesForModel: answerMessages,
      workspacePath,
      scannedFiles,
      patchValidation,
      logger,
      retryableCodes: RETRYABLE_PATCH_CODES,
      retryLimit: PATCH_CRITIC_RETRIES,
      normalizePatch,
      validateProposal: validateWithAstGuard,
      astOptions,
    });
  }

  // 2.5.b: Si aún no hay ningún patch válido, intenta síntesis desde contexto
  if (
    decision.taskType === "change-planning" &&
    patchValidation.every((item) => !item.validation.valid)
  ) {
    const synthesized = await synthesizePatchesFromContext({
      provider,
      messagesForModel: answerMessages,
      workspacePath,
      logger,
    });
    synthesisCoverage = synthesized.coverage;
    if (synthesized.patches.length > 0) {
      let synthesizedValidation = await validateDecisionProposedPatches({
        decision: { ...decision, proposedPatches: synthesized.patches },
        workspacePath,
        scannedFiles,
        logger,
        validateProposal: validateWithAstGuard,
      });

      const synthesizedAstOptions = buildAstOptionsFromProposals(
        synthesized.patches,
      );

      // Run critic loop on synthesized patches that failed validation
      if (synthesizedValidation.some((item) => !item.validation.valid)) {
        synthesizedValidation = await runPatchCriticLoop({
          provider,
          messagesForModel: answerMessages,
          workspacePath,
          scannedFiles,
          patchValidation: synthesizedValidation,
          logger,
          retryableCodes: RETRYABLE_PATCH_CODES,
          retryLimit: PATCH_CRITIC_RETRIES,
          normalizePatch,
          validateProposal: validateWithAstGuard,
          astOptions: synthesizedAstOptions,
        });
      }

      if (synthesizedValidation.some((item) => item.validation.valid)) {
        patchValidation = synthesizedValidation;
      } else if (patchValidation.length === 0) {
        // Show rejected synthesized patches so the user sees what failed
        patchValidation = synthesizedValidation;
      }
    }
  }

  // --- Phase 2.6: Sandbox verification on validated patch batch ---
  if (decision.taskType === "change-planning") {
    const validProposals = patchValidation
      .filter((item) => item.validation.valid)
      .map((item) => item.proposal);
    if (validProposals.length > 0) {
      try {
        sandboxVerification = await verifyPatchBatchInSandbox({
          workspacePath,
          proposals: validProposals,
        });
        logger.logSandboxVerify({
          command: sandboxVerification.command,
          patchCount: sandboxVerification.patchCount,
          verified: sandboxVerification.verified,
          exitCode: sandboxVerification.exitCode,
          stdoutPreview: sandboxVerification.stdout.substring(0, 400),
          stderrPreview: sandboxVerification.stderr.substring(0, 400),
        });

        // One-pass repair loop: if batch fails in sandbox, ask model for
        // corrective patches using compile errors from sandbox verification.
        if (!sandboxVerification.verified) {
          for (
            let attempt = 0;
            attempt < SANDBOX_REPAIR_RETRIES;
            attempt += 1
          ) {
            const repairedPatches = await requestSandboxRepairPatches({
              provider,
              answerMessages,
              currentValidPatches: validProposals,
              verificationStderr: sandboxVerification.stderr,
            });

            if (repairedPatches.length === 0) {
              logger.logSandboxVerifyFailed({
                command: sandboxVerification.command,
                patchCount: validProposals.length,
                reason: "Sandbox repair produced no proposedPatches",
                details: `attempt=${attempt + 1}`,
              });
              break;
            }

            let repairedValidation = await validateDecisionProposedPatches({
              decision: { ...decision, proposedPatches: repairedPatches },
              workspacePath,
              scannedFiles,
              logger,
              validateProposal: validateWithAstGuard,
            });

            const repairedAstOptions =
              buildAstOptionsFromProposals(repairedPatches);

            if (repairedValidation.some((item) => !item.validation.valid)) {
              repairedValidation = await runPatchCriticLoop({
                provider,
                messagesForModel: answerMessages,
                workspacePath,
                scannedFiles,
                patchValidation: repairedValidation,
                logger,
                retryableCodes: RETRYABLE_PATCH_CODES,
                retryLimit: PATCH_CRITIC_RETRIES,
                normalizePatch,
                validateProposal: validateWithAstGuard,
                astOptions: repairedAstOptions,
              });
            }

            const repairedValidProposals = repairedValidation
              .filter((item) => item.validation.valid)
              .map((item) => item.proposal);

            if (repairedValidProposals.length === 0) {
              logger.logSandboxVerifyFailed({
                command: sandboxVerification.command,
                patchCount: repairedPatches.length,
                reason: "Sandbox repair patches failed validation",
                details: `attempt=${attempt + 1}`,
              });
              break;
            }

            const repairedSandbox = await verifyPatchBatchInSandbox({
              workspacePath,
              proposals: repairedValidProposals,
            });

            logger.logSandboxVerify({
              command: repairedSandbox.command,
              patchCount: repairedSandbox.patchCount,
              verified: repairedSandbox.verified,
              exitCode: repairedSandbox.exitCode,
              stdoutPreview: repairedSandbox.stdout.substring(0, 400),
              stderrPreview: repairedSandbox.stderr.substring(0, 400),
            });

            if (repairedSandbox.verified) {
              patchValidation = repairedValidation;
              sandboxVerification = repairedSandbox;
              break;
            }
          }
        }
      } catch (error) {
        logger.logSandboxVerifyFailed({
          command: "npx tsc --noEmit",
          patchCount: validProposals.length,
          reason: "Sandbox verification crashed",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    answerMessages,
    patchValidation,
    decision,
    synthesisCoverage,
    sandboxVerification,
  };
}

export function buildAgentFinalResponse(
  answer: string,
  prelude: AgentContextPrelude,
): AgentModeOutcome {
  const withPatchSection = appendPatchSection(
    answer,
    prelude.patchValidation,
    prelude.decision.taskType,
    prelude.synthesisCoverage,
    prelude.sandboxVerification,
  );
  return {
    response: withPatchSection,
    validProposedPatches: prelude.patchValidation
      .filter((item) => item.validation.valid)
      .map((item) => item.proposal),
  };
}

export async function generateAgentModeResponse(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
  logger: AgentLogger;
}): Promise<AgentModeOutcome> {
  const { provider, messagesForModel, workspacePath, scannedFiles, logger } =
    params;

  const prelude = await prepareAgentContext({
    provider,
    messagesForModel,
    workspacePath,
    scannedFiles,
    logger,
  });
  const answer = await provider.completeChat(prelude.answerMessages);
  return buildAgentFinalResponse(answer, prelude);
}

function buildAstOptionsFromProposals(
  proposals: AgentProposedPatch[],
): AstValidationOptions | undefined {
  const createTargets = new Set<string>();
  for (const p of proposals) {
    if (p.patch.trimStart().startsWith("--- /dev/null")) {
      createTargets.add(p.file);
    }
  }
  return createTargets.size > 0 ? { createTargets } : undefined;
}

async function requestSandboxRepairPatches(params: {
  provider: ModelProvider;
  answerMessages: ChatSession["messages"];
  currentValidPatches: AgentProposedPatch[];
  verificationStderr: string;
}): Promise<AgentProposedPatch[]> {
  const { provider, answerMessages, currentValidPatches, verificationStderr } =
    params;

  const patchPreview = currentValidPatches
    .map(
      (p) =>
        `File: ${p.file}\n\n${p.patch.substring(0, 1800)}${p.patch.length > 1800 ? "\n... (truncated)" : ""}`,
    )
    .join("\n\n");

  const stderrPreview = verificationStderr.split("\n").slice(0, 80).join("\n");

  const repairMessages: ChatSession["messages"] = [
    ...answerMessages.slice(-6),
    {
      role: "user",
      content: [
        "The proposed patch batch failed sandbox verification (npx tsc --noEmit).",
        "Return corrected patches as AgentDecision JSON only.",
        "Use this exact shape:",
        '{"ready":true,"taskType":"change-planning","contextRequests":[],"proposedPatches":[{"file":"src/file.ts","description":"...","patch":"--- a/...\\n+++ b/...\\n@@ ..."}]}',
        "Do not include prose. Do not include markdown fences.",
        "Keep changes minimal and only for files needed to fix the errors.",
        "",
        "Current valid patches:",
        patchPreview,
        "",
        "Sandbox verification stderr:",
        stderrPreview,
      ].join("\n"),
    },
  ];

  try {
    const raw = await provider.completeChat(repairMessages);
    const repaired = parseAgentDecision(raw);
    return repaired.proposedPatches ?? [];
  } catch {
    return [];
  }
}
