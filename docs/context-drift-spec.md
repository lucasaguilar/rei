# Mini-spec: context-drift management (prune the detour, not branch)

Status: **SPEC (defined, not implemented).**

## Goal

You're deep in a feature and suddenly ask about an unrelated library, or the weather, or a
one-off question. That tangent then rides along in the working context every subsequent turn,
diluting the feature work. **Objective: detect the detour and keep it out of the working context.**

Explicitly NOT the goal: git-style branching / new branches / exploring alternatives. This is
*one linear thread with detours pruned from it*, not a tree.

## What REI has today (verified)

- **Session store** (`src/chat/session-store.ts`): the persisted session is a single JSON file
  (`.rei/sessions/*.json`, `version:1`) holding a **flat linear `messages[]`**. `createdAt` is one
  value for the whole session. There are **no indices**.
- **Per-message metadata** (`ChatMessage` in `src/chat/types.ts`): `role`, `content`,
  `reasoning_content?`, `tool_calls?`, `tool_call_id?`, `name?`, `sourceMode?`. The only structural
  tag is `sourceMode` (ask/planning/agent) — **too coarse** to detect drift (weather and the feature
  are both "ask").
- **Pruning lever — already exists:** the recency-tiered history demotion (`message-builder.ts`,
  `REI_VERBATIM_HISTORY_TURNS`, default 3) already selectively demotes old prose to a gist before
  sending to the model. See `[[rei-lean-history-demotion]]`.
- **Detector materials — already exist:** the local MiniLM embedder (`Xenova/all-MiniLM-L6-v2`, used
  by RAG) for similarity, plus the intent-router (`docs/intent-router-spec.md`) which already
  classifies every user message.
- **`agent-flow.jsonl`** (`src/core/logger.ts`): a per-event telemetry log WITH `timestamp`,
  `turnId` (regenerated each `startTurn()`), `phase` (incl. `USER_PROMPT`). It DOES have turn
  boundaries — but it's a **best-effort, write-only SINK** (its writer swallows errors). Use it for
  analysis, never as the pruning lever (context correctness must not depend on a best-effort log).

So the machinery to prune exists; what's missing is **(a) per-turn segmentation in the session** and
**(b) the signal + wiring that says "this turn is a detour."**

## Architecture rule

- **Detect** may read rich signals: the embedder, the intent-router, and (offline) `agent-flow.jsonl`.
- **Prune** acts ONLY on the session `messages[]` / the history-demotion path.
- Never make context correctness depend on the best-effort telemetry log.

## Design — three pieces

### 1. Segmentation — promote `turnId` into `ChatMessage`
The turn-boundary concept already exists in the logger (`turnId`). Carry it into the session instead
of inventing a new scheme: add an optional `turnId` (or `segmentId`) field to `ChatMessage`, stamped
when the message is appended — exactly how `sourceMode` was added. Reuse the logger's `turnId` value
so the session and `agent-flow.jsonl` **correlate** (analyze in the log, act on the session).
Backward-compatible (optional field; old sessions just have it undefined).

### 2. Detection — is this turn a detour?
Cheap signals, any of which flags a candidate (start permissive, tune later):
- **Tangent builtins:** the turn resolved to a clearly off-thread built-in (`weather`, an unrelated
  `web_search`) rather than touching workspace files.
- **Embedding distance:** embed the user turn (MiniLM) and compare to the *working-thread centroid*
  (running mean of on-thread turns); similarity below a threshold → drift candidate.
- **Intent-router topic switch:** extend the router (or a sibling) to flag an abrupt topic change.
- **Optional confirm (reuse the elicitation primitive):** *"This looks like a side question — keep it
  out of the feature context? [Yes / No]"*. Keeps the user in control; a wrong guess costs one key.

### 3. Pruning — exclude the detour from working context
Mark the detour turn's messages (e.g. `tangent: true`, keyed by `turnId`) and feed that flag into the
existing history-demotion: a tangent is **demoted to gist immediately** (not after
`REI_VERBATIM_HISTORY_TURNS`), so it stops riding along in the feature context. The detour is never
deleted from the session on disk — only kept out of what's sent to the model — so it stays recoverable.

## Config (proposed)
| Var | What | Default |
|---|---|---|
| `REI_DRIFT_DETECTION` | enable detour detection | `true` |
| `REI_DRIFT_CONFIRM` | ask before pruning a detour | `true` |
| `REI_DRIFT_SIMILARITY_MIN` | embedding-similarity threshold for on-thread | tune |

## Offline analysis bonus
Mine your own `agent-flow.jsonl` to build/tune the heuristic: turns whose `USER_PROMPT` is
weather/other-lib, turns with `CONTEXT_SEARCH` hitting unrelated files, turns with no `PATCH_*`. Real
detour examples for free — correlated to the session via the shared `turnId`.

## Connections
`[[rei-lean-history-demotion]]` (the pruning lever) · `[[rei-intent-router]]` (shared cheap
classifier + the elicitation confirm) · `[[rei-on-demand-file-context]]` (context-shaping siblings).

## Scope note
Small feature vs the git-tree idea it replaces: one new optional `ChatMessage` field + a detector
(reusing embedder/router) + one flag wired into the demotion. No new data model, no disk snapshots,
no branching UI.
