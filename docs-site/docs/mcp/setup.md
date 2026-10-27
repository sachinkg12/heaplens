---
sidebar_position: 2
title: Configure a local MCP server
---

Use a trusted native server matching the server machine's OS and architecture. This configuration targets the updated local implementation; it does not retrofit older installed binaries.

## Approve files and metadata sharing

```json
{
  "mcpServers": {
    "heaplens": {
      "command": "/absolute/path/hprof-server",
      "args": ["--mcp", "--mcp-allow-file", "/absolute/path/app.hprof", "--mcp-share-metadata"]
    }
  }
}
```

Repeat `--mcp-allow-file` for up to eight files. Only one completed analysis stays active. No flag approves a directory or lets a model approve more files. Without metadata sharing, tools reject requests. Sharing with no approved files returns an empty file list.

Use your client's documented configuration format. Windows paths require escaped backslashes in JSON and an available matching native build. The server needs no model key; the client owns model credentials, destination, retention and billing.

Treat launch configuration as a human permission boundary. Do not let an untrusted agent rewrite it. Stop and restart with fresh approval when files or permissions change. Approved captures must remain immutable: path and opened-handle metadata detect ordinary changes/replacements, not malicious same-size edits with restored timestamps. This is not cryptographic file verification.

## Initialize and analyze

Negotiated versions are 2024-11-05, 2025-06-18 and 2025-11-25. This is local stdio, not a remote authenticated service.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"heaplens-client","version":"1"}}}
```

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_dumps","arguments":{}}}
```

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"analyze_heap","arguments":{"dump_id":"dump_1"}}}
```

Use the returned analysis identity, not a guessed or saved one. Object IDs must be decimal strings. Frames are newline-delimited JSON; stdout is reserved for protocol data.

## Limits and cancellation

A connection accepts eight queued/running tool jobs and 4,096 unique tool request IDs; IDs cannot be reused. Metadata reads allow 32 ordinary rows, 4,096 visited nodes, 16,384 examined edges, depth 32, two seconds and 64 KiB of evidence. A path can include the selected node plus 32 hops. Queuing counts toward deadlines. A completed analysis retains at most 32 evidence records.

Analysis has a cooperative 30-minute deadline and uses normal Memory or Disk options. Neither the read budget nor the edge buffer is a total-RAM limit.

Send standard `notifications/cancelled` with the originating `requestId`. The server stops cooperative work and suppresses that request's response; unknown/late cancellation is ignored. Cancellation does not delete a successfully published structural cache. See the [MCP cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).
