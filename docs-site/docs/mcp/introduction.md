---
sidebar_position: 1
title: MCP for heap investigations
---

The updated local implementation exposes six metadata-only tools to compatible stdio MCP clients. Check `tools/list` on your executable; older published binaries can expose a different contract.

A human approves exact files and metadata sharing in the launch configuration. Tool arguments cannot grant permission or add files. The client chooses the model and may forward approved metadata to it. Names, identifiers, sizes and reference relationships can still be sensitive.

## Workflow

Configure approved files, initialize the connection, call `list_dumps`, then analyze a returned alias. Use the returned analysis identity for summaries, bounded reads and evidence retrieval. Reanalysis or switching dumps invalidates the previous state and handles. Only one completed analysis is retained; construction still needs resources appropriate to the dump.

No raw primitive/string contents, source, arbitrary filesystem reads, unrestricted queries or shell execution are exposed. These restrictions apply to direct calls as well as discovery. Inspector, Waste, HeapQL and Compare remain available in ordinary local hosts, not this MCP interface.

Cancellation is cooperative, including graph and derived-analysis walks. Allocations, sorting and operating-system I/O are not hard real-time operations. Stop the owned process on shutdown. See [setup](./setup.md), [tools](./tools-reference.md) and [privacy](../ai-integration/privacy.md).
