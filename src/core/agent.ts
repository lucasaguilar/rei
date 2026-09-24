import type { ModelProvider, TokenUsage } from "../providers/model-provider.js";
import {
  resolveModelForMode,
  createProviderForMode,
} from "../providers/provider-factory.js";
import { executeAgentTurnWithTools } from "../agent-mode/generator-tools.js";
import {
  mcpToolsToDefinitions,
  AGENT_TOOLS,
} from "../contracts/tool-definitions.js";
import {
  buildSystemMessage,
  getAgentEditFormat,
} from "../prompts/prompt-builder.js";
import { buildTurnContext } from "../context/context-builder.js";
import { buildMessagesForModel } from "../chat/message-builder.js";
import { isContextOverflowError } from "../providers/backend-error.js";
import { compactorModelFor, compactSession, needsCompaction } from "../chat/compactor.js";
import { type ChatSession } from "../chat/types.js";
import { getTotalStagesInPlan } from "../chat/plan-tracker.js";
import { VectorStore } from "../context/rag/vector-store.js";
import { getRelevantMapContext } from "../context/rag/map-retriever.js";
import { isOnDemandFileContextEnabled } from "../context/constants/context-builder.constants.js";
import type { FSWatcher } from "chokidar";
import {
  scanWorkspace,
  type FileMeta,
} from "../workspace/workspace-scanner.js";
import { applySREditBatchFS } from "../tools/patch-applier.js";
import { detectProjectType } from "../workspace/project-type.js";
import { KnowledgeOrchestrator } from "../knowledge/orchestrator.js";
import { AgentLogger } from "./logger.js";
import { SCAN_CACHE_TTL_MS } from "./constants/agent.constants.js";
import {
  buildTurnUserMessage,
  buildProjectFileTree,
  extractStageNumberFromPrompt,
  buildStageCompletionMessage,
  isStageSuccessful,
  stripThinkingBlock,
  cleanResponseForHistory,
} from "./helpers/turn-message.helpers.js";
import type { StreamTurnOptions } from "./models/agent.types.js";
import { formatBatchPatchResult } from "./helpers/action-executor.js";
import { type SkillMode } from "../skills/skill-loader.js";
import { resolveSessionModel } from "../chat/manual-model.js";
import { loadRole } from "../skills/role-loader.js";
import {
  ensureRepoMapIndexed,
  initWatcher,
} from "./helpers/repo-map-indexer.js";
import { isRagEnabled } from "../context/rag/rag-enabled.js";
import {
  stripAllActionTags,
  CREATED_FILES_MARKER,
} from "../agent-mode/helpers/patch-helpers.js";
import { formatCodeDiff } from "../cli/markdown-renderer.js";
import {
  calculateContextBudget,
  estimateToolsTokens,
} from "../context/context-budget.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  getMaxTurns,
  resolveReasoningEffort,
} from "../config/model-runtime.js";
import {
  resolveModelTuning,
  setActiveModelTuning,
} from "../config/model-tuning.js";
import { estimateTokens } from "../chat/helpers/token-estimator.js";
import {
  checkHardware,
  isOllamaProvider,
  resolveModelNameForHardwareCheck,
} from "./hardware-monitor.js";
import { McpRegistry } from "../tools/mcp/mcp-registry.js";
import {
  withTurnSpan,
  withTurnSpanStream,
  startStepSpan,
} from "../telemetry/spans.js";

export class Agent {
  private scanCache?: {
    workspacePath: string;
    files: FileMeta[];
    timestamp: number;
  };
  private knowledgeOrchestrator: KnowledgeOrchestrator;
  private vectorStore: VectorStore;
  private repoMapCache?: string;
  private watcher?: FSWatcher;
  public logger: AgentLogger;
  public readonly provider: ModelProvider;
  private readonly workspacePath: string;
  private correlationId: string;
  /** ID of the turn currently being processed. Stamped onto every ChatMessage produced this turn
   *  (user prompt + assistant/tool messages) so the flat session becomes segmentable for
   *  navigation/detour-pruning and correlates with agent-flow.jsonl. See docs/context-drift-spec.md. */
  private currentTurnId = "";
  /** Hardware warnings collected during prepareSessionForTurn — emitted at stream start. */
  private pendingHardwareWarnings: string[] = [];
  /** Token usage reported by the backend for the LAST completed turn (aggregated across its model
   *  calls). The CLI reads it after the stream ends to show REAL token counts instead of the
   *  chars/4 estimate. Reset at each turn start; undefined when the provider doesn't report usage. */
  private lastTurnUsage?: TokenUsage;
  /** The backend's prompt count for the most recent model call, kept ACROSS turns — unlike
   *  `lastTurnUsage`, which a new turn clears before compaction gets to run. It is what the
   *  compaction threshold is measured against, so it has to outlive the turn that produced it. */
  private lastMeasuredPromptTokens = 0;
  /**
   * The model the last turn actually ran on — reported, not re-derived.
   *
   * The status bar used to work it out again from the session mode, which was correct until a role
   * with a `preferredModel` could change it: the turn ran on the role's model while the bar named
   * the session's. Two derivations of one fact drift; one fact reported does not.
   */
  private lastTurnModel?: string;

  /** Backend-reported token counts for the last turn, when available (else undefined → estimate). */
  getLastTurnUsage(): TokenUsage | undefined {
    return this.lastTurnUsage;
  }

  /** The model the last turn ran on (a role's `preferredModel` when one was active). */
  getLastTurnModel(): string | undefined {
    return this.lastTurnModel;
  }
  /** Registry of connected MCP servers — populated lazily via connectMcp(). */
  public readonly mcpRegistry: McpRegistry;

  constructor(provider: ModelProvider, workspacePath: string = process.cwd()) {
    this.provider = provider;
    this.workspacePath = workspacePath;
    this.knowledgeOrchestrator = new KnowledgeOrchestrator(this.provider);
    this.logger = new AgentLogger(workspacePath);
    this.vectorStore = new VectorStore(workspacePath);
    this.mcpRegistry = McpRegistry.forWorkspace(workspacePath);
    this.correlationId =
      Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }

  /** Connect to all MCP servers defined in rei.config.json. */
  async connectMcp(): Promise<void> {
    await this.mcpRegistry.connect();
  }

  /** Disconnect all MCP servers and release their resources. */
  async disposeMcp(): Promise<void> {
    await this.mcpRegistry.dispose();
  }

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
  }

  /**
   * One prompt = one `rei.turn` root span (IP-2). Wraps the streaming Turn; the span
   * stays open until the caller finishes iterating. Tokens pass through unchanged.
   */
  streamTurn(
    session: ChatSession,
    userInput: string,
    options?: StreamTurnOptions,
  ): AsyncIterable<string> {
    return withTurnSpanStream(userInput, () =>
      this.streamTurnInternal(session, userInput, options),
    );
  }

  private async *streamTurnInternal(
    session: ChatSession,
    userInput: string,
    options?: StreamTurnOptions,
  ): AsyncIterable<string> {
    this.logger.startTurn();
    this.logger.setCorrelationId(this.correlationId);
    this.currentTurnId = this.logger.getTurnId();
    // A new turn starts with no backend-reported usage — the provider may not report any.
    this.lastTurnUsage = undefined;
    // An active role may prefer a DIFFERENT model than the session's — a reviewer you want a second
    // opinion from. Resolved here, before the tuning, because the two must agree: picking the
    // model without picking its rei.config.json entry runs it on the other model's sampling,
    // context window and thinking level.
    const turnRole = session.activeRole
      ? loadRole(session.activeRole, this.workspacePath)
      : null;
    // Most recent explicit choice first: `/model` (this session) beats the role's preference,
    // which beats the mode's configured model. See ChatSession.manualModel.
    const turnModel = resolveSessionModel(session, this.workspacePath);
    this.lastTurnModel = turnModel; // what the status bar reports, so it cannot disagree

    // Resolve this turn's per-model tuning (rei.config.json) ONCE; the config resolvers
    // (getContextWindow / resolveAgentSampling / reasoning_effort) read it. See model-config-spec.md.
    setActiveModelTuning(resolveModelTuning(turnModel, this.workspacePath));
    // Enriches the turn and PUSHES it onto the session — the pushed message is what gets sent,
    // so there is no enriched copy to hand around separately any more.
    await this.prepareSessionForTurn(session, userInput, options?.onStatus);
    await this.compactSessionIfNeeded(
      session,
      options?.onStatus,
      this.estimateActiveToolsTokens(session.mode),
    );

    // The tools schema costs ~2.3k tokens in agent mode and is invisible to the message builder,
    // which was budgeting against a window it only partly accounted for.
    const toolsOverhead = this.estimateActiveToolsTokens(session.mode);
    const baseMessagesForModel = buildMessagesForModel(
      session.messages,
      session.mode,
      session.mode === "agent" ? getAgentEditFormat() : undefined,
      toolsOverhead,
    );
    // No patching here any more: prepareSessionForTurn stored the enriched message itself, so what
    // the builder renders IS what gets sent. Rewriting it at send time is what broke the prefix.
    const messagesForModel = baseMessagesForModel;
    options?.onStatus?.("calling_model");

    // Emit any pending hardware warnings before the model response starts
    for (const warning of this.pendingHardwareWarnings) {
      yield warning;
    }
    this.pendingHardwareWarnings = [];

    if (session.mode === "agent") {
      const editFormat = getAgentEditFormat();
      const agentProvider = createProviderForMode("agent", this.provider);
      const chunksQueue: string[] = [];
      let resolver: (() => void) | null = null;
      let done = false;
      // Track whether any text was streamed via onChunk — used to prevent
      // double-buffering when the generator already streamed its response.
      let hasStreamedText = false;

      const onChunk = (chunk: {
        type: "thinking" | "text" | "status";
        content: string;
      }) => {
        // \x10 = thinking (dim italic live), \x11 = text (buffered, rendered at end), status = raw
        const encoded =
          chunk.type === "thinking"
            ? `\x10${chunk.content}`
            : chunk.type === "text"
              ? `\x11${chunk.content}`
              : chunk.content;
        if (chunk.type === "text") hasStreamedText = true;
        chunksQueue.push(encoded);
        resolver?.();
      };

      const startAttempt = (msgs: ChatSession["messages"]) => {
        done = false;
        return executeAgentTurnWithTools({
          provider: agentProvider,
          messagesForModel: msgs,
          workspacePath: this.workspacePath,
          logger: this.logger,
          // Same two role fields as the ask/planning branch below. They were missing here, so a
          // role with `baseMode: agent` — the ones that actually edit code — ran on the session's
          // model and with NO write restriction at all, while `/roles` and the status bar both
          // reported the role's. The two branches must stay in step; a meta-test now checks that.
          modelOverride: turnModel,
          reasoningEffort: resolveReasoningEffort("agent"),
          mcpRegistry: this.mcpRegistry,
          onChunk,
          drainUserMessages: options?.drainUserMessages,
          userQuery: userInput,
          roleWriteGlob: turnRole?.writeGlob,
          elicit: options?.elicit,
        }).finally(() => {
          done = true;
          resolver?.();
        });
      };

      let turnPromise = startAttempt(messagesForModel);
      let outcome: Awaited<ReturnType<typeof executeAgentTurnWithTools>> | undefined;

      // At most two attempts: the retry exists for ONE failure, the backend refusing the request
      // because it is too big (see isContextOverflowError). That is not a bug to surface — the
      // conversation simply outgrew what the backend will take, and compacting is the answer REI
      // already has. Without this the turn dies and every tool call it had already run is lost.
      for (let attempt = 0; outcome === undefined; attempt += 1) {
        // Nothing consumes the rejection until the drain loop ends; mark it handled so Node does
        // not report an unhandled rejection in between.
        turnPromise.catch(() => {});

        // Stream thoughts and action statuses to the user in real-time
        while (!done || chunksQueue.length > 0) {
          if (chunksQueue.length > 0) {
            yield chunksQueue.shift()!;
          } else {
            await new Promise<void>((resolve) => {
              resolver = resolve;
            });
          }
        }

        try {
          outcome = await turnPromise;
        } catch (err) {
          const overflow = isContextOverflowError(err);
          // One retry, and only when nothing has been shown yet: an overflow is refused during
          // prefill, before a single token exists, so a retry cannot duplicate visible output.
          if (attempt > 0 || !overflow || hasStreamedText) throw err;

          this.logger.logInfo("[overflow] backend refused the request — compacting and retrying", {
            error: err instanceof Error ? err.message : String(err),
          });
          yield `\n\x1b[33m⚠️  [REI] The backend refused the request as too large — compacting and retrying.\x1b[0m\n`;

          session.messages = (await compactSession({
            messages: session.messages,
            provider: this.provider,
            modelOverride: compactorModelFor(this.lastTurnModel),
            force: true,
          })).messages;
          turnPromise = startAttempt(
            buildMessagesForModel(
              session.messages,
              session.mode,
              session.mode === "agent" ? getAgentEditFormat() : undefined,
              toolsOverhead,
            ),
          );
        }
      }
      // Stash backend-reported usage for this turn — the CLI reads it after the stream ends.
      this.lastTurnUsage = outcome.usage;
      this.recordMeasuredPromptTokens(outcome.usage);

      // Keep the turn's tool traffic in the history, in the order the model saw it. What the model
      // received this turn then stays a byte-exact PREFIX of what it receives next turn, which is
      // the only condition under which a local backend reuses its KV cache. Dropping it used to
      // make every turn re-read the whole prompt: 40.36s against 0.59s, measured on oMLX.
      //
      // Pushed BEFORE the final answer below, so the sequence stays request → results → answer.
      if (outcome.turnMessages?.length) {
        session.messages.push(
          ...outcome.turnMessages.map((m) => ({ ...m, turnId: this.currentTurnId })),
        );
      }

      // Si hay parches válidos, aplicarlos directamente
      if (
        outcome.validProposedPatches &&
        outcome.validProposedPatches.length > 0
      ) {
        const result = await applySREditBatchFS(
          outcome.validProposedPatches,
          this.workspacePath,
        );
        const msg = formatBatchPatchResult(result);
        session.messages.push({
          role: "assistant",
          content: cleanResponseForHistory(outcome.response),
          turnId: this.currentTurnId,
        });
        options?.onStatus?.("producing_response");
        // Yield clean explanation as rendered text (only if not already streamed via onChunk).
        // msg starts with \n\n---\n — strip leading whitespace so spacing is controlled by the CLI.
        const explanation = stripAllActionTags(
          stripThinkingBlock(outcome.response),
        );
        if (explanation && !hasStreamedText) yield `\x11${explanation}`;
        // Honest signal: if the final combined verify did NOT pass, the model
        // exhausted its self-correction retries — warn the user instead of
        // implying the changes compile.
        if (outcome.verified === false) {
          yield `\n\x1b[33m⚠️  [REI] Applied, but the combined changes do NOT pass the project type-check. Review before relying on them.\x1b[0m\n`;
        }
        yield msg.trimStart();
        // Show diff for each applied patch so the user can see exactly what changed.
        for (const edit of outcome.validProposedPatches) {
          const applied = result.results.find(
            (r) => r.file === edit.file && r.applied,
          );
          if (applied) {
            yield `\n\x1b[1mFile:\x1b[0m ${edit.file}\n\`\`\`diff\n${formatCodeDiff(edit.search, edit.replace)}\n\`\`\``;
          }
        }

        if (result.success) {
          const stageNum = extractStageNumberFromPrompt(userInput);
          if (stageNum !== null) {
            const total = getTotalStagesInPlan(this.workspacePath);
            yield buildStageCompletionMessage(stageNum, total, true);
          }
        }

        return;
      }

      // No XML interception here. Actions arrive as structured tool_calls; scanning the model's
      // prose for <execute_command>/<call_tool> would run whatever a mention of the legacy syntax
      // happened to look like — and no prompt emits it (formats/agent-format-tools.md forbids it).

      // Si no hay parches, solo responde
      session.messages.push({
        role: "assistant",
        content: cleanResponseForHistory(outcome.response),
        turnId: this.currentTurnId,
      });
      options?.onStatus?.("producing_response");
      // Only yield the response text if it wasn't already streamed via onChunk
      // (completeChatWithTools doesn't stream, so we must emit; XML generators do stream).
      const plainResponse = stripThinkingBlock(outcome.response);
      if (!hasStreamedText) {
        yield `\x11${plainResponse}`;
      } else {
        // Prose was already streamed/buffered; surface only content appended AFTER
        // streaming (the created-files summary) so it isn't lost. Yielded raw → shown live.
        const markerIdx = plainResponse.indexOf(CREATED_FILES_MARKER);
        if (markerIdx !== -1) {
          yield plainResponse.slice(markerIdx);
        }
      }

      if (!outcome.failed) {
        const stageNum = extractStageNumberFromPrompt(userInput);
        const succeeded =
          editFormat === "wholefile"
            ? true
            : isStageSuccessful(outcome.response);
        if (stageNum !== null && succeeded) {
          const total = getTotalStagesInPlan(this.workspacePath);
          yield buildStageCompletionMessage(stageNum, total, true);
        }
      }

      return;
    }

    // ── ask/planning ─────────────────────────────────────────────────────────
    // Routes ask/planning through the SAME native function-calling loop as agent, gated to a
    // read-only tool profile (toolsForMode → read_files / run_command / git_changes + web/MCP/
    // skills, NO edits): the model investigates via real tool calls instead of emitting unreliable
    // XML tags. Streams live through callModel's streamChatWithTools when present.
    if (this.nativeToolsActive(session.mode)) {
      const askProvider = createProviderForMode(session.mode, this.provider);
      const chunksQueue: string[] = [];
      let resolver: (() => void) | null = null;
      let done = false;
      let hasStreamedText = false;

      const onChunk = (chunk: {
        type: "thinking" | "text" | "status";
        content: string;
      }) => {
        const encoded =
          chunk.type === "thinking"
            ? `\x10${chunk.content}`
            : chunk.type === "text"
              ? `\x11${chunk.content}`
              : chunk.content;
        if (chunk.type === "text") hasStreamedText = true;
        chunksQueue.push(encoded);
        resolver?.();
      };

      const turnPromise = executeAgentTurnWithTools({
        provider: askProvider,
        messagesForModel,
        workspacePath: this.workspacePath,
        logger: this.logger,
        // The role's preferredModel when one is active — resolved above, together with its tuning.
        modelOverride: turnModel,
        reasoningEffort: resolveReasoningEffort(session.mode),
        mcpRegistry: this.mcpRegistry,
        onChunk,
        userQuery: userInput,
        mode: session.mode as SkillMode,
        // Narrows what this turn may write — see write-scope.
        roleWriteGlob: turnRole?.writeGlob,
        elicit: options?.elicit,
      }).finally(() => {
        done = true;
        resolver?.();
      });

      while (!done || chunksQueue.length > 0) {
        if (chunksQueue.length > 0) {
          yield chunksQueue.shift()!;
        } else {
          await new Promise<void>((resolve) => {
            resolver = resolve;
          });
        }
      }

      const outcome = await turnPromise;
      this.lastTurnUsage = outcome.usage;
      this.recordMeasuredPromptTokens(outcome.usage);
      session.messages.push({
        role: "assistant",
        content: cleanResponseForHistory(outcome.response),
        sourceMode: session.mode,
        turnId: this.currentTurnId,
      });
      options?.onStatus?.("producing_response");
      // Only emit the response text if it wasn't already streamed live via onChunk.
      const plainResponse = stripThinkingBlock(outcome.response);
      if (!hasStreamedText) yield `\x11${plainResponse}`;
      return;
    }
  }

  private getWorkspaceFiles(): FileMeta[] {
    const now = Date.now();
    if (
      this.scanCache &&
      this.scanCache.workspacePath === this.workspacePath &&
      now - this.scanCache.timestamp < SCAN_CACHE_TTL_MS
    ) {
      return this.scanCache.files;
    }

    const files = scanWorkspace(this.workspacePath);
    this.scanCache = {
      workspacePath: this.workspacePath,
      files,
      timestamp: now,
    };
    return files;
  }

  private get useToolCalling(): boolean {
    const agentProvider = createProviderForMode("agent", this.provider);
    return typeof agentProvider.completeChatWithTools === "function";
  }

  /**
   * Whether the native function-calling path applies this turn. True whenever the active provider
   * (agent-scoped for agent mode, else the primary) supports tool calls — which is now REQUIRED,
   * since the XML interception path was removed. Single source of truth for prompt selection (native
   * *-tools prompt), MCP-tools delivery (API param vs prompt text), and the ask/planning dispatch.
   */
  private nativeToolsActive(mode: ChatSession["mode"]): boolean {
    const provider =
      mode === "agent"
        ? createProviderForMode("agent", this.provider)
        : this.provider;
    return typeof provider.completeChatWithTools === "function";
  }

  /**
   * Estimates the tokens consumed by the function-calling `tools` array sent on every
   * agent tools-path request (built-in AGENT_TOOLS + connected MCP tool schemas). This
   * is NOT part of the message history, so the context gauge would otherwise under-report
   * usage — large MCP servers can silently occupy a big share of the window. Returns 0
   * when tools aren't sent (non-agent mode, or a provider without tool-calling).
   */
  public estimateActiveToolsTokens(mode: string): number {
    if (mode !== "agent" || !this.useToolCalling) return 0;
    const toolDefs = [
      ...AGENT_TOOLS,
      ...mcpToolsToDefinitions(this.mcpRegistry.getAvailableTools()),
    ];
    return estimateToolsTokens(toolDefs);
  }

  private async updateSystemContextWithRepoMap(
    session: ChatSession,
    userInput?: string,
    onStatus?: StreamTurnOptions["onStatus"],
  ): Promise<string | undefined> {
    let repositorySkeletonMap: string | undefined = undefined;

    // 1. Asegurar que el mapa esté generado e indexado en el VectorStore
    if (!this.repoMapCache) {
      this.repoMapCache = await ensureRepoMapIndexed({
        workspacePath: this.workspacePath,
        vectorStore: this.vectorStore,
        logger: this.logger,
        onStatus,
      });
      if (isRagEnabled()) {
        this.initWatcher(); // init watcher only if RAG is enabled
      }
    }

    // 2. Recuperar solo fragmentos relevantes basados en la entrada del usuario
    if (userInput) {
      // const relevantMap = await getRelevantMapContext(
      //   this.vectorStore,
      //   userInput,
      // );
      // repositorySkeletonMap = relevantMap
      //   ? `### RELEVANT REPOSITORY SKELETON MAP\n\n${relevantMap}`
      //   : undefined;
      if (!isRagEnabled()) {
        // No vector store to query — skip semantic retrieval.
        // The flat repo map is still in the system prompt.
        repositorySkeletonMap = undefined;
      } else {
        const relevantMap = await getRelevantMapContext(
          this.vectorStore,
          userInput,
        );
        repositorySkeletonMap = relevantMap
          ? `### RELEVANT REPOSITORY SKELETON MAP\n\n${relevantMap}`
          : undefined;
      }
    } else {
      repositorySkeletonMap = undefined;
    }

    return repositorySkeletonMap;
  }



  /**
   * Builds the system prompt and seats it at index 0 of the session.
   *
   * This used to live inside updateSystemContextWithRepoMap, which on-demand file context skips —
   * and on-demand is the DEFAULT for every mode. So the prompt that carries REI's identity, the
   * response rules, the mode's instructions, the project's own rules and the verify command was not
   * being sent AT ALL: the model received the tool-calling directive and nothing else. Measured on a
   * real turn: 1,688 chars of prompt where there should have been 10,633.
   *
   * The two jobs had nothing to do with each other. The repo map is a context-budget decision; the
   * system prompt is not optional. See systemPromptAlwaysTravels in agent-system-prompt.test.ts.
   */
  private ensureSystemPrompt(session: ChatSession): void {
    // Rebuild system message on every turn or when mode changes, to keep the active plan progress checklist in sync.
    // An active role (auditor, …) injects its posture into the prompt. See docs/roles-spec.md.
    const activeRole = session.activeRole
      ? loadRole(session.activeRole, this.workspacePath)
      : null;
    const baseSystemContent = buildSystemMessage(
      session.mode,
      this.workspacePath,
      activeRole?.body,
    );
    let systemContent = baseSystemContent;

    // MCP tools are delivered to the model via the API `tools` param on every (native) turn, so no
    // text tool-list is injected into the prompt — that path was XML-only and is gone.

    // Surface the project's REAL verify command so the model self-verifies correctly instead of
    // defaulting to a generic `tsc --noEmit` (which skips Angular templates, AOT/DI, and other
    // framework checks). This is the SAME command REI runs as its final check — detected per
    // project type. Only in agent mode (where edits happen) and when a real check exists.
    if (session.mode === "agent") {
      const { type, verifyCommand } = detectProjectType(this.workspacePath);
      if (verifyCommand && verifyCommand !== "echo ok") {
        systemContent +=
          `\n\n## Verifying your changes\n` +
          `This project's verify command (type: ${type}) is:\n\`\`\`\n${verifyCommand}\n\`\`\`\n` +
          `Run it with run_command to check your work — it is the SAME check REI runs at the end. ` +
          `Use THIS command, not a generic \`tsc --noEmit\`: for Angular it misses template/AOT ` +
          `errors. For dynamic projects (Python/JS) also run the project's tests/linters ` +
          `(e.g. \`npm test\`, \`pytest\`, \`mypy\`) when your change affects behavior.`;
      }
    }

    if (session.messages.length > 0 && session.messages[0].role === "system") {
      session.messages[0].content = systemContent;
    } else {
      session.messages.unshift({ role: "system", content: systemContent });
    }

  }

  private async prepareSessionForTurn(
    session: ChatSession,
    userInput: string,
    onStatus?: StreamTurnOptions["onStatus"],
  ): Promise<string> {
    // Hardware check runs concurrently with context building (non-blocking)
    // TEMPORARY: disabled for debugging — re-enable after testing
    // if (isOllamaProvider(session.mode)) {
    //   onStatus?.("checking_hardware");
    //   const hwStatus = await checkHardware({
    //     ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    //     targetModel: resolveModelNameForHardwareCheck(session.mode),
    //   });
    //   this.pendingHardwareWarnings = hwStatus.warnings;
    //   if (hwStatus.warnings.length > 0) {
    //     this.logger.logInfo("[hardware] Warnings detected", { warnings: hwStatus.warnings });
    //   }
    // } else {
    this.pendingHardwareWarnings = [];
    // }

    onStatus?.("building_context");
    // On-demand mode never injects the proactive repo map (see below), so skip GENERATING it too —
    // otherwise every turn re-scans the whole repo and rewrites a large
    // .rei/logs/repo-skeleton-map.txt (can be MBs) for nothing. The model discovers structure with
    // tools instead. Only the explicit opt-out (REI_ON_DEMAND_FILE_CONTEXT_<MODE>=0) builds the map.
    // ALWAYS, whatever the file-context mode decides: the repo map is a budget decision, the system
    // prompt is not optional (see ensureSystemPrompt).
    this.ensureSystemPrompt(session);

    const onDemand = isOnDemandFileContextEnabled(session.mode);
    const repositorySkeletonMap = onDemand
      ? undefined
      : await this.updateSystemContextWithRepoMap(session, userInput, onStatus);
    this.logger.logUserPrompt({
      mode: session.mode,
      prompt: userInput,
    });

    // Calculate token budget so context-builder can trim if the window is tight.
    // Resolved from the unified config (0 = unknown → no trimming). The response
    // reserve IS the model's output cap, so the budget never over-reserves.
    const numCtx = getContextWindow();
    const responseReserve = getMaxOutputTokens();
    const systemMessage = session.messages.find((m) => m.role === "system");
    const historyMessages = session.messages.filter((m) => m.role !== "system");

    // The function-calling `tools` array (sent only on the agent tools path) is
    // NOT part of the message history, so account for it here — large MCP servers
    // (e.g. Google Workspace) add many tool schemas that would otherwise overflow
    // the model's context invisibly.
    let toolsTokens = 0;
    if (session.mode === "agent" && this.useToolCalling) {
      const toolDefs = [
        ...AGENT_TOOLS,
        ...mcpToolsToDefinitions(this.mcpRegistry.getAvailableTools()),
      ];
      toolsTokens = estimateToolsTokens(toolDefs);

      // Warn clearly if the tools array alone eats a large share of the window —
      // far more actionable than LM Studio's cryptic 400 context-overflow error.
      if (numCtx > 0 && toolsTokens > numCtx * 0.4) {
        this.pendingHardwareWarnings.push(
          `\n\x1b[33m⚠️  [REI] The connected MCP tools occupy ~${toolsTokens} tokens ` +
            `(${Math.round((toolsTokens / numCtx) * 100)}% of the ${numCtx}-token window). ` +
            `This can overflow the model's context. Reduce the enabled MCP tools ` +
            `(e.g. enable only the services you need) or load the model with a larger context.\x1b[0m\n`,
        );
      }
    }

    const tokenBudget = calculateContextBudget({
      numCtx,
      systemPrompt: systemMessage?.content ?? "",
      history: historyMessages,
      userInput,
      responseReserve,
      toolsTokens,
    });

    const scannedFiles = this.getWorkspaceFiles();

    const context = await buildTurnContext({
      workspacePath: this.workspacePath,
      scannedFiles,
      userInput,
      mode: session.mode,
      knowledgeOrchestrator: this.knowledgeOrchestrator,
      onStatus,
      tokenBudget,
    });

    if (context.budgetTrimmed) {
      this.logger.logInfo(
        "[context-budget] Context trimmed to fit token window",
        {
          numCtx,
          responseReserve,
          tokenBudget,
        },
      );
    }

    if (context.ragResults && context.ragResults.length > 0) {
      this.logger.logContextSearch(
        userInput,
        context.ragResults.map((r) => ({
          filePath: r.metadata.filePath,
          nodeType: r.metadata.nodeType,
          nodeName: r.metadata.nodeName,
          score: r.score,
        })),
      );
    }

    // On-demand mode (the default for ALL modes) gives PURE on-demand orientation — like
    // Pi/Hermes/OpenCode, we inject NO proactive repo map or file tree. Sending a partial/collapsed
    // view misleads the model (it concludes unseen files "don't exist") and defeats caching; instead
    // the model discovers structure with tools (ls / find / git ls-files / read_files). Only a mode
    // explicitly opted out (REI_ON_DEMAND_FILE_CONTEXT_<MODE>=0) injects the proactive map + tree.
    // `onDemand` was computed above (it also gated the map generation).
    // No agent-mode format reminder is appended here any more: the edit format now comes from ONE
    // place, the stored message built by buildTurnUserMessage (see message-builder.ts). There is
    // nothing to duplicate, and the stored message is what goes out.
    const enrichedMessage = buildTurnUserMessage({
      userInput,
      context,
      repositorySkeletonMap: onDemand ? undefined : repositorySkeletonMap,
      projectFileTree: onDemand
        ? undefined
        : buildProjectFileTree(scannedFiles),
    });

    this.logger.logInfo("Enriched user message size", {
      chars: enrichedMessage.length,
      estimatedTokens: Math.round(enrichedMessage.length / 4),
    });

    // Persist EXACTLY what the model is about to receive.
    //
    // This used to store the raw input while sending the enriched one, and the difference was not
    // cosmetic: the next turn re-sent that same message WITHOUT its enrichment, so the prompt no
    // longer began with what the backend had already processed. Local runtimes cache the KV of the
    // last prompt and reuse it only while the new prompt EXTENDS it — one changed byte early in the
    // history and the whole thing is re-read.
    //
    // Measured against oMLX (Qwen3.8-27B-MLX-4bit, ~27.5k tokens, max_tokens=1): re-sending the
    // message unchanged prefilled in 0.73s; re-sending it stripped back to raw took 61.11s, with a
    // SMALLER prompt. Same conversation, 83x, decided by whether the prefix still matched.
    //
    // The invariant this buys: what was sent on turn N is a byte-exact prefix of turn N+1 (see
    // prompt-prefix-stability.test.ts). The turn's tool traffic is persisted right after this
    // point (in streamTurnInternal), in the order the model saw it, so the next turn EXTENDS the
    // cached prefix instead of diverging from it.
    session.messages.push({
      role: "user",
      content: enrichedMessage,
      turnId: this.currentTurnId,
    });

    return enrichedMessage;
  }

  /** Remembers the backend's own prompt count, which outranks any estimate of the same thing. */
  private recordMeasuredPromptTokens(usage?: TokenUsage): void {
    const measured = usage?.lastPromptTokens ?? usage?.promptTokens;
    if (measured && measured > 0) this.lastMeasuredPromptTokens = measured;
  }

  private async compactSessionIfNeeded(
    session: ChatSession,
    onStatus?: StreamTurnOptions["onStatus"],
    /** System prompt + tools — the part of the window compaction was not counting. */
    fixedOverheadTokens = 0,
  ): Promise<void> {
    const measuredPromptTokens = this.lastMeasuredPromptTokens;
    if (!needsCompaction(session.messages, fixedOverheadTokens, measuredPromptTokens)) {
      return;
    }

    onStatus?.("compacting_memory");
    const compaction = await compactSession({
      messages: session.messages,
      provider: this.provider,
      modelOverride: compactorModelFor(this.lastTurnModel),
      fixedOverheadTokens,
      measuredPromptTokens,
    });
    session.messages = compaction.messages;
    // The measurement described the history that was just cut, so it would re-trigger compaction
    // every turn until a fresh reading arrived. The next model call reports one.
    if (!compaction.skipped) {
      this.lastMeasuredPromptTokens = 0;
      // Auto-compaction used to finish in silence: "compacting memory" is a SPINNER label, erased
      // by the next phase, so the history shrank with nothing left on screen to say so — and
      // `/compact` got run again by hand over a session that had just been compacted. Manual
      // /compact always reported itself; the automatic path never did.
      onStatus?.("memory_compacted");
    }
    // Auto-compaction stays non-fatal — the turn goes on with the full history — but a silent skip
    // here is how a session sails past its window and dies on the next request instead.
    if (compaction.skipped) {
      this.logger.logInfo("[compactor] skipped, history kept in full", { reason: compaction.skipped });
    }
  }

  private initWatcher(): void {
    if (this.watcher) return;
    this.watcher = initWatcher({
      workspacePath: this.workspacePath,
      vectorStore: this.vectorStore,
      logger: this.logger,
      clearScanCache: () => {
        this.scanCache = undefined;
      },
    });
  }
}
