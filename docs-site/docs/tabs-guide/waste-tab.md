---
sidebar_position: 5
title: Waste
---

Waste includes **duplicate strings, empty collections, over-allocated collections, and boxed primitives**. The total and category values are estimates; waste percentage uses total modeled heap.

## Investigate a group

Sort the relevant table and inspect groups/instances locally. Duplicate-string previews are bounded (the backend truncates previews to 120 characters), not complete strings. Tables/top groups can be bounded too.

| Category | Read | Investigate |
| --- | --- | --- |
| Strings | Copies, total bytes, estimated extra bytes | Already-shared backing storage and identity requirements |
| Empty collections | Class/count and footprint | Actual backing allocation and required mutability |
| Over-allocation | Capacity/size estimates and unused bytes | Expected growth and recognized layout |
| Boxed values | Wrapper/primitive difference | Nullability, APIs, caching, identity |

## Before optimizing

Deduplication can share storage without removing String objects. Replacing strings with null/enums or wrappers with primitives can change behavior. Default empty maps/lists need not allocate their eventual backing array. Layout recognition and grouping estimates are not universal across JDKs/custom collections.

Do not promise the whole total is independently reclaimable. Read [estimation limitations](../concepts/waste-analysis.md).

## Sharing and export

The local view/report can retain string previews. Available host export/save/download actions preserve their contents; scrub before sharing. Minimized editor prompts omit those previews, but MCP data does not pass through that filter. See [privacy](../ai-integration/privacy.md).

Compare four-category deltas using equivalent snapshots, not only a duplicate-string subtotal.
