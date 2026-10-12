---
sidebar_position: 8
title: Compare
---

Select a baseline and current analyzed snapshot through the host's controls. Verify labels/direction: deltas are **current minus baseline**. Compare summary, per-class histogram, suspect classifications, and all four waste categories.

## Comparable captures

Keep workload, capture/GC conditions, JVM/layout, analyzer version/backend, and options comparable. File creation time is not necessarily capture time. IDs are not stable cross-snapshot identity.

| Label | Actual meaning |
| --- | --- |
| New | Class/candidate appears in the compared output |
| Resolved | Previously reported candidate is absent under the current detector |
| Persisted | Candidate appears in both outputs |
| Grew / shrank | Positive / negative measured aggregate delta |

Resolved is **not proof a leak was fixed or a specific byte count freed**. Persisted is not proof a continuing leak. Thresholds, workloads, and capture conditions can change classifications; unchanged aggregates can hide object turnover.

## Waste and exports

Total estimated waste combines duplicate, empty, over-allocation, and boxed categories. A consistent illustrative change: -40 KiB strings, -5 KiB empty, +10 KiB over-allocation, -1 KiB boxed gives **-36 KiB** total. This is arithmetic, not a benchmark or guaranteed reclaim.

Exports/downloads include names and can include paths. Review before sharing. Host adapters can compare compact snapshots across isolated processes; native compare requires analyzed states, while the CLI releases the baseline graph before loading current.

See [API result fields](../api-reference/data-structures.md) and [Timeline](./timeline-tab.md) for trend investigation. Comparison controls and export destinations differ by host.
