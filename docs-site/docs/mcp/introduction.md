---
sidebar_position: 1
title: MCP for heap investigations
---

MCP lets a compatible client or coding agent call the local HeapLens server's **nine tools**. The client owns the model and tool permissions. No IDE is required.

## Local does not mean nothing is shared

The native process reads a local server-machine HPROF path and returns analysis/tool data. The client may send those results—including class names, previews, and primitive values—to its model. Editor prompt minimization does not apply. See [privacy](../ai-integration/privacy.md).

Dragging a dump into chat does not reliably provide a local filesystem path accessible to this server. Supply an authorized path that the configured server can read, especially in remote/container/sandbox clients.

## Workflow

Initialize the stdio connection, list tools, analyze a safe dump, then request a bounded histogram/query, inspect an object, or drill into ownership. Compare requires both analyzed snapshots in the same native server process.

The server retains graphs/mappings until process termination. Large or multiple dumps can need substantial RAM. A client timeout is not proof the server stopped, and automatic result replay after timeout is not promised.

Use the same native version/backend/options when comparing editor versus MCP engine results. A shared library is architectural evidence, not a substitute for a runtime equivalence test.

See [setup](./setup.md), [all tools](./tools-reference.md), and [remote workflows](../getting-started/remote-development.md).
