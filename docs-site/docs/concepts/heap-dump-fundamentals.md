---
sidebar_position: 1
title: Heap dump fundamentals
---

import FlowDiagram from '@site/src/components/FlowDiagram';

A heap dump is a **snapshot** of recorded objects and relationships—not allocation history, a CPU profile, or proof that an object is obsolete. HeapLens builds a reference graph and derives modeled sizes and ownership locally.

<FlowDiagram kind="analysis" />

## What is recorded?

Class layouts distinguish references from primitive fields. Instances/arrays carry opaque IDs and contents. GC-root records supply reachability entry points. Some format variants provide heap-type information and extended roots.

The serialized ID width does not prove the JVM's physical reference width. The HPROF format header is **not a reliable Java release number**: `JAVA PROFILE 1.0.2` alone cannot identify JDK 27. Compatibility depends on supported records/layouts and fixtures. OpenJ9 PHD is a different format; renaming it does not convert it. Android records do not establish universal JVM/Android-version coverage.

## Four different sizes

| Quantity | Meaning |
| --- | --- |
| File bytes | Serialized HPROF length |
| Total modeled heap | Sum of shallow sizes, including recorded unreachable objects |
| Reachable modeled heap | Shallow bytes reachable in the retaining graph |
| Analyzer RSS | Resident mapped pages plus analysis/process allocations |

Memory mapping avoids an eager application-buffer copy. It does **not** consume zero RAM or eliminate graph memory requirements.

## Interpret relationships

Removing one reference makes an object collectible only if no other retaining path remains. Static fields retain values while their class/classloader is reachable, not forever. Tracing GC can collect unreachable cycles.

A [dominator tree](./dominator-tree.md) summarizes unavoidable ownership, not every actual reference. Use [Why alive / Inspect](../tabs-guide/object-inspector.md) to investigate. Protect immutable captures and compare equivalent workloads/GC conditions. See [safe capture](../getting-started/generating-heap-dumps.md).
