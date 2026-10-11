---
sidebar_position: 9
title: Timeline
---

Timeline compares at least two selected analyzed snapshots. It is an ordered snapshot view, **not continuous recording or allocation history**.

## Build a three-snapshot investigation

1. Capture three dumps under documented, comparable workload/GC conditions.
2. Open/analyze each in the host. Select available snapshots in Timeline; uncheck any you do not want.
3. Build Timeline and verify the returned snapshot order/labels.
4. Read total-heap trends, top-class lines, and growth tables. Rebuild after changing selection.

The native timeline uses file modification timestamps for ordering; those may reflect a copy, not true capture time. Other host adapters may assemble compact snapshots differently. Record capture times yourself and verify labels; do not derive a per-minute rate from an arbitrary filename/order.

## Interpret missing and growing classes

Class summaries are bounded to selected top classes. A missing line is not necessarily a missing class in the heap. Zero/missing aggregates and changed class rankings can affect charts. Names group classes, not persistent individual object IDs.

Growth is a signal, not proof of leakage: workload, GC, and layout choices matter. Use Compare, root paths, and lifecycle evidence. Retained totals across class lines can overlap.

Use available native export/browser downloads for local results; do not assume every host has the same export controls. Disconnecting/closing a dump can remove its availability for future rebuilds; previously drawn results are not proof its server still runs.

For live metrics use [Monitor](./monitor-tab.md), which has a separate agent and network boundary.
