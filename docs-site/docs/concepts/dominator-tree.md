---
sidebar_position: 2
title: Dominators and shared references
---

import ReferenceExample from '@site/src/components/ReferenceExample';

A dominates B if **every retaining path** from the synthetic root to B passes through A. The immediate dominator is the nearest such ancestor; it need not directly reference B.

<ReferenceExample />

Owner references Payload directly and through Second. Owner dominates both, but Second does not dominate Payload because a route bypasses Second. A tree omits the actual Second → Payload reference.

## Retained bytes

Retained size is shallow size plus the modeled shallow bytes of the dominator subtree. It is a graph counterfactual—not a promise that deleting one variable implements that object removal in live code.

Illustrative example, **not a benchmark**:

| Object | Shallow bytes | Retained bytes |
| --- | --- | --- |
| Owner | 24 | 1,048,624 |
| Second | 24 | 24 |
| Payload | 1,048,576 | 1,048,576 |

Owner's total already includes the other two objects. Adding retained totals double-counts Payload. Another independent root to Payload would change Owner's retention.

## Investigation

Expand [Dominator Tree](../tabs-guide/dominator-tree-tab.md), then use Inspect, Show referrers, and Why alive. A large bounded cache may be expected. Its owner class is not necessarily the repair location.

Dominators are computed before UI expansion. Lazy child loading reduces rendering work, not initial graph RAM. Initial displayed top entry points need not be a disjoint partition of root children. See [size semantics](./retained-vs-shallow-size.md).
