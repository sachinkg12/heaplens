---
sidebar_position: 2
title: Rust analysis engine
---

import FlowDiagram from '@site/src/components/FlowDiagram';

The analyzer library is shared; command-line/server entry points adapt it to different transports. Default indexed analysis uses packed nodes and CSR edges; legacy graph analysis remains a separate backend.

<FlowDiagram kind="analysis" />

## Pipeline

1. Open a completed immutable HPROF and map it read-only.
2. Decode strings/class/heap records and field layouts, including inherited fields.
3. Build nodes and retaining references. Primitive bytes are not object edges merely because their values resemble IDs.
4. Compute root reachability, dominators, and retained totals.
5. Produce histogram, suspect, waste, and bounded entry-point results.
6. Retain graph/mapping state for subsequent query/inspection requests.

The indexed path can parallelize edge extraction. Retained propagation follows the computed dominator tree. Complexity/resource use depends on the actual representation and graph shape—not only the algorithm's name.

## Representation

Packed object IDs map to node indexes. CSR stores edge offsets/targets contiguously; layout metadata helps reference decoding. Analysis state stores shallow/retained sizes, children, class information, and reference-query state. Mappings/cache entries stay alive while their state is used.

`memmap2`, the HPROF parser, Rayon, serialization, and graph/dominator code have distinct roles; licenses/notices remain distributed with packages.

## Memory and lazy loading

Mapping avoids a full eager user-buffer copy, but resident pages, object indexes, edges, dominator arrays, and scratch allocations consume RAM. “Indexed” here does not mean persistent on-disk indices. Disk-backed graph analysis and a configurable analysis-memory budget are not currently available.

Lazy tree/table loading limits UI output; it does not defer all initial graph/dominator construction. A --rows/LIMIT flag does not impose an analysis RAM budget.

## Limits and provenance

HPROF payload length/ID width does not identify exact producer layout or JDK version. Size-model metadata explicitly marks estimates and incomplete classes. Supported weak/soft/phantom referents are excluded from the retaining graph according to policy.

Historical timings are preserved in [recorded measurements](../runbook/recorded-measurements.md), with unresolved provenance visible. They are not universal latency/RAM promises. See [performance](../runbook/performance-tuning.md) and [data structures](../api-reference/data-structures.md).
