---
sidebar_position: 2
title: Rust analysis engine
---

import FlowDiagram from '@site/src/components/FlowDiagram';

The analyzer library is shared; command-line/server entry points adapt it to different transports. Default indexed analysis uses packed nodes and CSR edges; legacy graph analysis remains a separate backend.

<FlowDiagram kind="analysis" />

## Pipeline

1. Open a completed immutable HPROF and map it read-only.
2. Read metadata and allocation records, emitting partial record counts. Estimate full-analysis resource needs before allocating count-sized working tables.
3. Build nodes and the shallow histogram. Hosts can show these results while graph-dependent values remain unavailable.
4. Build retaining references, or load a verified disk-backed structure. Primitive bytes are not object edges merely because their values resemble IDs.
5. Compute root reachability, dominators, retained totals, suspects and bounded object results. These results replace the shallow-only view for the current request.
6. Retain graph/mapping state for subsequent query/inspection requests. Calculate Waste only when requested with the indexed backend.

The indexed path can parallelize edge extraction. Retained propagation follows the computed dominator tree. Complexity/resource use depends on the actual representation and graph shape—not only the algorithm's name.

## Representation

Packed object IDs map to node indexes. CSR stores edge offsets/targets contiguously; layout metadata helps reference decoding. Analysis state stores shallow/retained sizes, children, class information, and reference-query state. Mappings/cache entries stay alive while their state is used.

`memmap2`, the HPROF parser, Rayon, serialization, and graph/dominator code have distinct roles; licenses/notices remain distributed with packages.

## Memory and disk storage

Memory storage is the default and rebuilds the structure for each analysis. Optional Disk storage persists versioned structural indexes with mapped nodes, body/array catalogs and forward/reverse CSR references. Shared dictionaries and selectively encoded columns avoid expanding every persisted table before use. Writers use bounded batches; this does not make every phase constant-memory.

<FlowDiagram kind="storage" />

A fresh disk build verifies the persisted components before publishing an index directory atomically. Reopening checks the complete capture fingerprint, component checksums and version/policy identity before mapping the structure. Dominators and derived retained results are recomputed; they are not persisted completed results. Waste candidate metadata can be loaded or decoded as needed, while content reads still use the original capture.

Mapping avoids a full eager user-buffer copy, but resident pages, lookup construction, metadata, dominator arrays and scratch allocations consume RAM. Cooperative cross-process admission reserves estimated working memory against OS availability; it is not a hard RSS limit. Closing a dump releases its process/state but leaves completed disk indexes available for reuse.

## Staged results and Quick Scan

Full analysis emits shallow results as an intermediate stage and continues automatically. Standalone **Quick Scan** is a different operation: it collects allocation totals and a shallow histogram without installing a reference graph. **Analyze Retained** starts a fresh full analysis explicitly. Neither path substitutes shallow bytes for retained bytes.

Lazy tree/table loading limits UI output; it does not defer all initial graph/dominator construction. A --rows/LIMIT flag does not impose an analysis RAM budget.

## Limits and provenance

HPROF payload length/ID width does not identify exact producer layout or JDK version. Size-model metadata explicitly marks estimates and incomplete classes. Supported weak/soft/phantom referents are excluded from the retaining graph according to policy.

Historical timings are preserved in [recorded measurements](../runbook/recorded-measurements.md), with unresolved provenance visible. They are not universal latency/RAM promises. See [performance](../runbook/performance-tuning.md) and [data structures](../api-reference/data-structures.md).
