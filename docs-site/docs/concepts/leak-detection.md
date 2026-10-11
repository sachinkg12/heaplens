---
sidebar_position: 5
title: Leak suspects are evidence, not verdicts
---

HeapLens ranks substantial modeled retention. A snapshot cannot prove obsolete objects or unbounded growth. **High retention is a lead; low percentages are not proof of safety.**

## Indexed detector

| Candidate | Current heuristic |
| --- | --- |
| Classloader | Above 5% reachable heap, using class/classloader relationships |
| Class | Above 10% reachable heap |
| Individual object | Above 10% reachable heap |
| Accumulation point | Follow the largest dominated child while it retains at least 70% of its parent |

These are implementation thresholds, not calibrated probabilities. UI By Object / By Class and percentage filtering are not identical to detector thresholds. Legacy/backdated behavior can differ.

## Validate the cause

A map may be bounded; a loader may be current; a buffer may intentionally retain peak capacity. `byte[]` identifies storage, not the owner causing retention. Follow fields, referrers, roots, and lifecycle evidence.

Equivalent captures after completed work/GC can show persistence or growth. A disappearing suspect can also reflect a threshold or workload change.

A repair needs an identified lifecycle violation, functional tests, equivalent captures, and representative workload measurements. Closing a resource does not generally clear heap references. In particular, `ByteArrayOutputStream.close()` has no effect, and reset permits buffer reuse: [API contract](https://docs.oracle.com/javase/8/docs/api/java/io/ByteArrayOutputStream.html).

See [Leak Suspects](../tabs-guide/leak-suspects-tab.md), [Compare](../tabs-guide/compare-tab.md), and [AI limitations](../ai-integration/privacy.md).
