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
} from "./constants/generator.constants.js";
import { extractProvidedContextPaths } from "./helpers/decision-path.helpers.js";
import { runDecisionPhase } from "./helpers/decision-phase.helpers.js";
import { appendContextToLastUserMessage } from "./helpers/context-message.helpers.js";
import { validateWithAstGuard } from "./helpers/patch-semantic-validation.helpers.js";
import { synthesizePatchesFromContext } from "./helpers/patch-repair.helpers.js";
import { runPatchCriticLoop } from "./helpers/patch-critic.helpers.js";
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
    if (synthesized.length > 0) {
      let synthesizedValidation = await validateDecisionProposedPatches({
        decision: { ...decision, proposedPatches: synthesized },
        workspacePath,
        scannedFiles,
        logger,
        validateProposal: validateWithAstGuard,
      });

      const synthesizedAstOptions = buildAstOptionsFromProposals(synthesized);

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

  return { answerMessages, patchValidation, decision };
}

export function buildAgentFinalResponse(
  answer: string,
  prelude: AgentContextPrelude,
): AgentModeOutcome {
  const withPatchSection = appendPatchSection(
    answer,
    prelude.patchValidation,
    prelude.decision.taskType,
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
