---
sidebar_position: 2
title: Configure a local MCP server
---

Use a trusted native `hprof-server` for the server machine's OS/architecture. A source checkout is an option for contributors, not a universal user requirement. The current standalone candidate can supply the native server; check [distribution status](../getting-started/choose-host.md).

## Client configuration

In a client supporting local stdio MCP, configure the actual executable:

```json
{
  "mcpServers": {
    "heaplens": {
      "command": "/absolute/path/hprof-server",
      "args": ["--mcp"]
    }
  }
}
```

This is a common configuration shape, not a promise every client uses this file/schema. Use its documented configuration location and approve permissions. Windows JSON paths must be escaped:

```json
{
  "mcpServers": {
    "heaplens": {
      "command": "C:\\tools\\heaplens\\hprof-server.exe",
      "args": ["--mcp"]
    }
  }
}
```

The server itself does not need an LLM API key. The client may need one for its own model.

## Initialization contract

Current server code advertises **2024-11-05**. A standards-aware client must inspect the returned version/capabilities instead of assuming the newest protocol is implemented. An illustrative manual stdio exchange:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"heaplens-docs-check","version":"1.0"}}}
```

After accepting a compatible initialization response, send:

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

Then list/call tools:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"analyze_heap","arguments":{"path":"/absolute/path/app.hprof"}}}
```

Messages are newline-delimited JSON on stdio. Keep stdout for protocol data and stderr for diagnostics. This is not the editor RPC notification sequence. The [MCP lifecycle specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) explains negotiation; it does not establish that HeapLens implements every newer capability.

## Verify and stop

Check nine tool names, analyze one safe dump, run a bounded valid query, and inspect client errors/permissions. Use server-machine paths. Do not assume arbitrary remote paths or every coding agent are supported. On shutdown terminate the owned process to release state. Client cancellation support differs; no general cancellable MCP-analysis guarantee is made.

Tool output can be sensitive. Read [privacy](../ai-integration/privacy.md) before allowing a cloud-model client to use it.
