---
sidebar_position: 3
title: Dominator Tree
---

import ReferenceExample from '@site/src/components/ReferenceExample';

Explore unavoidable ownership, with expansion, child loading, paging, keyboard navigation, Back to Root, and a Flame Graph presentation.

## Expand and investigate

The starting rows are selected **top entry points**, not necessarily SuperRoot's immediate children or a disjoint heap partition. Expand a row for immediately dominated children. Child loading is lazy in the UI; the backend has already computed the graph/dominators.

Use Why alive, Inspect, Show referrers, Jump/View Source, and Fix with AI where the host provides the action. Fix can resolve project source independently of View Source; dependency/decompiled classes are not automatically editable source.

<ReferenceExample />

## Bytes versus percentages

Nested rows overlap and must not be added. A large ArrayList, its Object[] and its contents can all describe the same retained bytes. A dominator edge need not be an actual field reference.

**Known host difference:** the audited VS Code renderer divides by the sum of displayed top-entry retained sizes, which can overlap. IntelliJ divides by reachable heap. Do not compare these percentages as equivalent or call both “% of reachable heap.” Compare byte values and size models until the product denominator issue is corrected. Flame Graph areas and displayed roots likewise should not be treated as a guaranteed whole-heap partition.

## Source and AI

Opening an owner class does not prove that file causes the leak. Fix with AI requires matching project source and full-file approval. Review proposal changes and apply/Undo controls; test behavior and new captures. Closing an output stream is not a universal way to release buffers.

## Large trees and failures

Page/expand progressively, collapse unused branches, and Back to Root to reset focus. An empty child list can mean a leaf or an unknown ID. If the process exits, Retry and verify one expansion/query afterward; stale failure text should not survive recovery. See [recovery](../runbook/troubleshooting.md).
