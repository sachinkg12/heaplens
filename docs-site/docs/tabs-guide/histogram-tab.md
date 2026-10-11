---
sidebar_position: 2
title: Histogram
---

One row groups a class's recorded instances. Filter class names, sort column headers, use Show all for the bounded initial list, and open an instance preview for detailed investigation.

| Column | Meaning |
| --- | --- |
| Instances | Recorded instance count for this class |
| Shallow | Sum of modeled own-object bytes |
| Retained | Within-class non-overlapping retained subtrees |
| % | Retained / reachable heap in the corrected histogram |

Same-class dominated descendants are counted once. Cross-class totals still overlap; do not add them into total heap usage. Unreachable objects can contribute shallow bytes but no root-retained bytes.

## Find the right object

Sorting shallow totals finds classes using storage collectively, not their largest individual instance. Divide by count for an average, or query actual instances:

```heapql
SELECT object_id, class_name, shallow_size, retained_size
FROM instances
WHERE class_name = 'java.lang.String'
ORDER BY shallow_size DESC
LIMIT 20
```

Use an instance's Inspect, Why alive, or referrer action where offered. Source actions resolve classes through the host; dependency/JDK behavior differs.

## Export and limits

CSV export is local: native save in an IDE or download in the browser adapter. Names and exact sizes are not anonymized. Large class lists/instance previews can be bounded; use filtering or queries rather than assuming a displayed subset is the complete heap.

Validate exports against displayed headers/byte semantics. See [size definitions](../concepts/retained-vs-shallow-size.md) and [Object Inspector](./object-inspector.md).
