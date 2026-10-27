---
sidebar_position: 4
title: Requests, results, and actions
---

import FlowDiagram from '@site/src/components/FlowDiagram';

<FlowDiagram />

## Analysis events

1. Host starts its trusted native server and sends analyze_heap with a local server-machine path.
2. Server acknowledges processing with a request_id. This is not completion.
3. Progress events update the UI with partial record counts and then a shallow summary/histogram. Reachable/retained values remain unavailable while reference and dominator work continues.
4. Completion supplies summary, bounded objects/layers, histogram, suspects and storage status. Indexed Waste remains unavailable until requested separately; errors/cancellation are distinct outcomes.
5. Host routes the event only to its current session and renders views.

Exact wire keys are in [RPC](../api-reference/rpc-methods.md). A modeled heap of 1 MiB cannot contain a 512 MiB retained object; examples here use no fabricated measurement payloads.

<FlowDiagram kind="analysis" />

**Quick Scan** sends `scan_heap` instead. It ends after the shallow allocation summary/histogram without building a reference graph. **Analyze Retained** starts a fresh `analyze_heap`; receiving a shallow snapshot during an already running full analysis does not start another job.

## On-demand investigation

Expand → get_children → ObjectReport rows. Why alive → gc_root_path → ordered bounded path. Inspect → inspect_object → optional field records. Query → execute_query → columns/rows, timing and optional pagination. These operations read cached analysis; view loading is not complete lazy graph construction.

Referrers show actual incoming references; dominator children show immediate domination, not necessarily a direct field edge.

**Calculate Waste** invokes `get_waste_analysis` after full analysis. Its result is cached for that native analysis and updates the requesting host's snapshot. Interactive Waste comparisons need calculated results for both snapshots.

## Optional source/model flow

<FlowDiagram kind="ai" />

Fix resolves eligible source, confirms destination/full-file disclosure, sends only after approval, then opens a proposal for review. Cancel/Review Source do not transmit source. Model output cannot execute a repair by itself.

The updated local investigation loop attaches current bounded metadata and scoped completed history, then allows at most four model calls and three metadata reads per question. Facts select evidence fields; HeapLens renders their values. Restored display-only history is not evidence. External MCP tools require separate launch-time exact-file and metadata approval; the external client controls its own model prose.

## Persistence and export

Active graphs/maps live in native process state. Optional Disk mode also persists private structural indexes across process lifetimes. Reopening verifies the capture and index before loading mapped structures and recomputing dominators; Memory mode rebuilds the structure. Host settings, secrets, chat history, and source proposals have separate lifetimes. Closing/disposal releases owned processes, not completed indexes; Retry starts a new analysis and may reuse a valid structural index.

Export writes/downloads local data, not automatic cloud upload. Reports can contain names, paths, and previews. Telemetry sends only its approved bounded contract and does not approve source submission. See [telemetry](../runbook/telemetry.md).
