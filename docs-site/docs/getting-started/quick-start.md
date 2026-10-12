---
sidebar_position: 2
title: Your first investigation
---

Use a small authorized dump first. Keep the completed capture immutable during analysis and open your source project for navigation.

## Follow the memory

1. In **Overview**, read the size model, total versus reachable heap, and counts. Heap bytes are modeled object sizes, not file length or analyzer RAM.
2. In **Histogram**, sort by shallow size to find storage-heavy classes, or retained size to investigate ownership.
3. In **Dominator Tree**, expand a large owner. Child rows load on demand; nested retained totals overlap and must not be added.
4. Use **Why alive?**, **Inspect**, and **Show referrers** to check roots, fields, and incoming references.
5. Use **Source** to investigate the matching class. An owner is not necessarily the code needing repair.

A large object or a suspect is a lead, not proof of a leak. Validate lifecycle intent and comparable snapshots.

## Run a query

In Query, run:

```heapql
SELECT object_id, class_name, shallow_size, retained_size
FROM instances
ORDER BY retained_size DESC
LIMIT 20
```

Compare a result with the inspector. IDs belong to this dump, not stable cross-capture identity. See the [HeapQL reference](../api-reference/heapql.md).

## All eleven views

The current UI has [Overview](../tabs-guide/overview-tab.md), [Histogram](../tabs-guide/histogram-tab.md), [Dominator Tree](../tabs-guide/dominator-tree-tab.md), [Leak Suspects](../tabs-guide/leak-suspects-tab.md), [Waste](../tabs-guide/waste-tab.md), [Source](../tabs-guide/source-tab.md), [Query](../tabs-guide/query-tab.md), [Compare](../tabs-guide/compare-tab.md), [Timeline](../tabs-guide/timeline-tab.md), [Monitor](../tabs-guide/monitor-tab.md), and [AI Chat](../tabs-guide/ai-chat-tab.md). [Object Inspector](../tabs-guide/object-inspector.md) is a panel, not a twelfth tab.

[Host capabilities](./choose-host.md) differ in source lookup, settings, exports and approval. Use the guide for your chosen host.

## AI, reports, recovery

Read [AI privacy](../ai-integration/privacy.md) before configuring a provider or approving source. Model responses and fixes need review and testing.

**Copy Incident Report** is local but can include paths and previews; scrub it before sharing. Exports do not upload automatically.

If a server exits, use Retry for that dump. A slow analysis is not an exited process: choose Continue Waiting or Cancel when offered. See [recovery](../runbook/troubleshooting.md).
