---
sidebar_position: 3
title: Shallow, retained, and percentage sizes
---

Shallow size measures an object's own modeled footprint. Retained size measures bytes in its dominator subtree that lose modeled root reachability if it is removed.

For a reachable object, retained includes shallow. “Large shallow, little additional retention” is meaningful; retained smaller than shallow for that reachable object is not. Recorded unreachable objects can have shallow bytes but no root-retained contribution.

## JVM layout estimates

Current estimates include headers, reference slots, array headers, and alignment. Hidden VM fields/class metadata are excluded. Inspect `summary.size_model` and its warnings, especially inferred/overridden parameters. Serialized payload length and ID width do not determine exact allocation size.

Previously recorded fixture checks against JVM sizes and an independent reference analyzer are historical validation, not a new test of every JVM/JDK/collector.

## Denominators and overlap

| Quantity | Meaning |
| --- | --- |
| Histogram shallow | Sum of class shallow bytes, including recorded unreachable instances |
| Histogram retained | Within-class non-overlapping retained subtrees; same-class descendants are counted once |
| Cross-class retained | Can overlap; not an additive heap partition |
| Indexed suspect percentage | Candidate retained / reachable heap |
| Waste percentage | Estimated waste / total modeled heap |
| File length or RSS | Not a retained-size denominator |

Histogram retained is a minimum-style within-class aggregate, not all memory collectively kept alive by an arbitrary set. A collection, its array, and its contents can each describe the same bytes. A primitive byte array has no object references just because it stores serialized content.

## Known tree percentage difference

The audited VS Code tree uses the sum of displayed top-entry retained sizes, which can overlap. IntelliJ uses reachable heap. Bytes can match while percentages differ. A documentation update does not fix that renderer; see [Dominator Tree](../tabs-guide/dominator-tree-tab.md).

Compare identical backends/layout/reachability options. Display rounding can hide small differences; use byte-valued API/query results for arithmetic.
