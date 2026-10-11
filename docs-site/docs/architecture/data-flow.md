---
sidebar_position: 4
title: Requests, results, and actions
---

import FlowDiagram from '@site/src/components/FlowDiagram';

<FlowDiagram />

## Analysis events

1. Host starts its trusted native server and sends analyze_heap with a local server-machine path.
2. Server acknowledges processing with a request_id. This is not completion.
3. Progress/summary events may update the UI during computation.
4. Completion supplies summary, bounded objects/layers, histogram, suspects, and waste; errors/cancellation are distinct outcomes.
5. Host routes the event only to its current session and renders views.

Exact wire keys are in [RPC](../api-reference/rpc-methods.md). A modeled heap of 1 MiB cannot contain a 512 MiB retained object; examples here use no fabricated measurement payloads.

## On-demand investigation

Expand → get_children → ObjectReport rows. Why alive → gc_root_path → ordered bounded path. Inspect → inspect_object → optional field records. Query → execute_query → columns/rows, timing and optional pagination. These operations read cached analysis; view loading is not complete lazy graph construction.

Referrers show actual incoming references; dominator children show immediate domination, not necessarily a direct field edge.

## Optional source/model flow

<FlowDiagram kind="ai" />

Fix resolves eligible source, confirms destination/full-file disclosure, sends only after approval, then opens a proposal for review. Cancel/Review Source do not transmit source. Model output cannot execute a repair by itself.

Chat context is bounded/minimized. Current VS Code follow-ups can omit the initial analysis injection; do not equate stored plain chat history with persistent complete heap context. MCP tool output is a separate client-controlled boundary.

## Persistence and export

Graphs/maps live in native process state. Host settings, secrets, chat history, and source proposals have separate lifetimes. Closing/disposal releases owned processes; Retry creates new analysis rather than reviving the same graph.

Export writes/downloads local data, not automatic cloud upload. Reports can contain names, paths, and previews. Telemetry sends only its approved bounded contract and does not approve source submission. See [telemetry](../runbook/telemetry.md).
