---
sidebar_position: 2
title: Setup
---

# MCP Server Setup

This guide covers how to configure HeapLens as an MCP server for use with Claude Desktop or other MCP-compatible AI clients.

## Prerequisites

1. Build the `hprof-server` binary:

```bash
cd hprof-analyzer
cargo build --release
```

The binary will be at `hprof-analyzer/target/release/hprof-server`.

## Claude Desktop Configuration

Add HeapLens to your Claude Desktop MCP configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "heaplens": {
      "command": "/absolute/path/to/hprof-server",
      "args": ["--mcp"]
    }
  }
}
```

Replace `/absolute/path/to/hprof-server` with the actual path to the built binary, e.g.:

```json
{
  "mcpServers": {
    "heaplens": {
      "command": "/Users/you/HeapLens/hprof-analyzer/target/release/hprof-server",
      "args": ["--mcp"]
    }
  }
}
```

## Verification

1. Restart Claude Desktop after saving the configuration
2. Open a new conversation
3. You should see HeapLens's tools available (look for the tools icon)
4. Ask Claude to analyze a heap dump:

```
Please analyze the heap dump at /tmp/my-heap.hprof
```

Claude will call the `analyze_heap` tool and return the results.

## Manual Testing

You can test the MCP server directly from the command line:

```bash
# Start the server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | ./hprof-server --mcp
```

Expected response:
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"heaplens","version":"0.1.0"}}}
```

To list available tools:
```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | ./hprof-server --mcp
```

## How the MCP Server Differs from JSON-RPC Mode

| Aspect | JSON-RPC Mode (VS Code) | MCP Mode |
|--------|------------------------|----------|
| Startup | `hprof-server` (no flag) | `hprof-server --mcp` |
| Protocol | Custom JSON-RPC 2.0 | MCP standard |
| Analysis | Async (returns "processing", then notification) | Synchronous (blocks until done) |
| Responses | Structured JSON objects | LLM-friendly markdown text |
| State | Per-file, persistent across requests | Per-file, persistent across requests |
| Concurrency | Async tokio runtime | Synchronous stdin loop |

Both modes use the same analysis engine and produce identical results. The difference is in how the results are formatted and delivered.

## Troubleshooting

### "No tools available" in Claude Desktop

- Verify the path in `claude_desktop_config.json` is absolute and the binary exists
- Check that the binary has execute permissions: `chmod +x hprof-server`
- Restart Claude Desktop completely (quit and relaunch)

### Analysis takes too long

MCP mode runs analysis synchronously. A 2 GB dump completes in ~1-2 seconds; a 14 GB dump takes ~11 seconds. Claude Desktop may show a timeout warning for very large files — this is normal; the result will appear when done.

### "No analysis found" errors

You must call `analyze_heap` before using other tools like `get_leak_suspects` or `drill_down`. Each tool requires a `path` parameter, and the file must have been analyzed first in the same session.
