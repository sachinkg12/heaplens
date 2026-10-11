---
sidebar_position: 6
title: Waste estimates and their limits
---

Waste highlights potentially avoidable patterns. Estimated bytes are **not guaranteed reclaimable memory**, nor a guarantee that an optimization preserves behavior.

| Implemented category | Estimate | Validate first |
| --- | --- | --- |
| Duplicate strings | Additional content-group copies | Already-shared backing arrays, grouping, identity, collector behavior |
| Empty collections | Detected empty-instance footprint | Object overhead versus actual backing capacity and required mutability |
| Over-allocated collections | Unused recognized backing capacity | Future growth, layout/JDK, size/capacity fields |
| Boxed primitives | Wrapper overhead versus primitives | Nullability, identity, APIs, cached values |

All four categories are implemented. Waste percentage uses **total modeled heap**, unlike suspect percentages.

## Capacity is not automatically leakage

Default empty HashMap/ArrayList instances do not necessarily allocate eventual backing storage eagerly. String deduplication can share storage without removing each String object. Interning is not universally appropriate or permanently strong in modern HotSpot; collector options vary by JVM version. Nulls/enums/unboxed replacements can change contracts.

## Estimation limits

Per-copy string estimates may overcount already-shared arrays. Recognized collection layouts/extraction heuristics do not establish correctness for every JDK or third-party structure. Unsupported objects can be missed; category estimates need not be independently reclaimable.

Use previews, then inspect actual backing objects and test a semantic-preserving optimization. Previews can reveal sensitive text. They are omitted from minimized editor prompts but remain in local reports/exports and MCP output. See [Waste](../tabs-guide/waste-tab.md) and [privacy](../ai-integration/privacy.md).
