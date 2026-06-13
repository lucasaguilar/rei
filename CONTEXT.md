# CONTEXT — Glossary

Canonical language for the rei project. This file is a **glossary only** — definitions of
domain terms, not implementation notes, specs, or decisions. When a term here conflicts with
how something is being described, the glossary wins until the glossary is changed.

> Scope note: terms below were sharpened during the Multi-Agent A2A + OTel work. They apply
> project-wide unless stated otherwise.

---

## Turn
One user prompt and the assistant's **complete** response to it — the whole exchange.
This is the unit handled by a single `runTurn` / `streamTurn` call.

- A Turn is composed of one or more **Steps**.
- Not to be confused with a Step (see below). Historically the code and earlier plans used
  "turn" for both levels; that overload is retired.

## Step
One iteration of the agent's reasoning loop **within a Turn**: a single model call plus any
tools it invokes in that round. The loop runs up to a bounded number of Steps per Turn.

- A Turn → many Steps; a Step → one model call (+ its tool executions).
- The `MAX_TURNS` environment variable bounds **Steps per Turn**, despite its name.

## Agent
The in-process reasoning engine that executes Turns and invokes tools. A single class instance.
Distinct from a **Node** (the running process) and from **agent-mode** (a session mode).

## agent-mode
The session mode in which the assistant may modify the workspace — edit/create files, run
commands — as opposed to `ask` / `plan` modes, which are advisory and do not change the workspace.

## A2A Node
Any process that participates in A2A — it can **serve** delegated tasks and/or **delegate** tasks to
others — **regardless of how it is implemented**. A2A is a cross-framework protocol, so a network can
mix Node kinds. A Node referenced in another Node's configuration (by label + URL) is still just a
Node; we do **not** use a separate term ("Peer") for that vantage.

## rei A2A Node
An A2A Node implemented by a rei process (as opposed to, e.g., a **Claude A2A Node**). Hosts one
interactive Agent and serves delegated tasks via a dedicated Agent.

## Identity
What a Node *is* — its **single area of responsibility** (its specialty), declared as name /
description / skills in its AgentCard. A Node follows the **Single Responsibility Principle**: it does
one job well (the "librarian" does library things; the "auditor" analyses architecture). **Self-declared**
and **stable** across tasks — a Node knows its own Identity. Distinct from Role.

## Role
Whether a Node acts as **Orchestrator** or **Worker** for a given task. **Emergent and per-task** —
never hardcoded, not known in advance. A Node has a fixed Identity but a contextual Role
(the same Node can orchestrate one task and be a worker for another).

## Orchestrator / Worker
The two Roles. An **Orchestrator** decomposes a task and delegates subtasks; a **Worker** executes a
delegated task and returns a result. A Worker may itself become an Orchestrator for sub-delegations.
