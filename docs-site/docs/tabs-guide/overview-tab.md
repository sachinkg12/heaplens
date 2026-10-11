---
sidebar_position: 1
title: Overview
---

Overview is the starting point: modeled total/reachable heap, object/class/array/root counts, size-model provenance, top retained objects, and Quick Checks.

## Read the summary first

Total heap includes modeled shallow bytes of recorded objects. Reachable heap uses the retaining graph. Neither equals file length or analyzer RSS. Size-model warnings describe uncertainty; hidden VM fields/class metadata are excluded.

Top retained objects and the heap-composition treemap/bar charts are **selected ownership entries**, not a disjoint partition. A collection, its array, and elements can describe overlapping storage.

## Actions

- Select **Why alive?** on an object to inspect a root path.
- Use Inspect / Show referrers where offered; IDs are scoped to the dump.
- **Copy Incident Report** copies a local summary/report. It can include paths and previews; scrub before sharing.
- Follow class/source actions into the project, then validate whether that owner is the repair location.

Quick Checks are heuristic leads. A high `byte[]` percentage identifies storage, not automatically a stream-close bug. Warnings/errors should be read as text as well as color.

## Progress and recovery

Early summary/progress updates can arrive before full analysis finishes; actions needing the completed graph may not yet be available. Hosts can present progress differently.

A dead per-tab server exposes Retry. Slow analysis offers waiting/cancellation rather than proving a crash. Closing one editor should not stop another editor's server. See [troubleshooting](../runbook/troubleshooting.md).

[Host availability](../getting-started/choose-host.md) distinguishes published VSIX targets from candidates. For investigation continue to [Histogram](./histogram-tab.md).
