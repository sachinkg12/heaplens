---
sidebar_position: 1
title: System Overview
---

# System Overview

HeapLens is a two-process system: a TypeScript VS Code extension that provides the UI and orchestration, and a Rust binary that performs the CPU-intensive heap analysis. They communicate over JSON-RPC 2.0 via stdin/stdout.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     VS Code Extension (TypeScript)               │
│                                                                   │
│  extension.ts                                                     │
│  ├─ Registers HprofEditorProvider for .hprof files               │
│  ├─ Registers commands: analyzeFile, exportJson                  │
│  └─ Initializes DependencyResolver for source bridging           │
│                                                                   │
│  HprofEditorProvider                                              │
│  ├─ Opens .hprof → spawns RustClient (one per file)             │
│  ├─ Manages per-editor state (analysis data, chat, webview)     │
│  ├─ Routes messages between webview and Rust backend             │
│  └─ Handles: getChildren, chatMessage, gcRootPath, copyReport   │
│                                                                   │
│  RustClient (JSON-RPC 2.0 wrapper)                               │
│  ├─ Spawns hprof-server as subprocess                            │
│  ├─ Sends requests → receives responses + notifications          │
│  └─ Request timeout (30s default)                                │
│                                                                   │
│  Webview (HTML/CSS/JS, rendered in VS Code panel)                │
│  ├─ 7 tabs: Overview, Histogram, Dominator Tree, Leak Suspects, │
│  │          Waste, Source, AI Chat                                │
│  ├─ D3.js v7 for pie chart and sunburst visualization            │
│  └─ Communicates with extension via postMessage                  │
│                                                                   │
│  LLM Integration                                                  │
│  ├─ analysisContext.ts — formats heap data for LLM context       │
│  ├─ llmClient.ts — streaming API calls (Anthropic/OpenAI)       │
│  └─ chatParticipant.ts — VS Code Copilot Chat integration       │
│                                                                   │
│  Source Bridge                                                    │
│  ├─ sourceResolver.ts — maps class names to source files         │
│  └─ dependencyResolver.ts — Maven/Gradle dependency lookup       │
│                                                                   │
├───────────────────── stdin/stdout ────────────────────────────────┤
│                                                                   │
│                     Rust Backend (hprof-server)                    │
│                                                                   │
│  main.rs — Async server (tokio)                                   │
│  ├─ JSON-RPC mode (default) — for VS Code extension             │
│  │   ├─ analyze_heap → async notification when done              │
│  │   ├─ get_children → dominator tree drill-down                 │
│  │   ├─ export_json → structured JSON export                     │
│  │   └─ gc_root_path → GC root reference chain                  │
│  │                                                                │
│  └─ MCP mode (--mcp flag) — for AI clients (Claude Desktop)     │
│      ├─ analyze_heap, get_leak_suspects, get_class_histogram     │
│      ├─ drill_down, get_summary, get_waste_analysis              │
│      └─ Returns LLM-friendly markdown text                       │
│                                                                   │
│  lib.rs — Core analysis engine                                    │
│  ├─ HPROF parsing via jvm-hprof crate (zero-copy, mmap)         │
│  ├─ Graph construction (CSR edge storage, 2-phase: nodes then edges) │
│  ├─ Dominator tree (Lengauer-Tarjan algorithm)                   │
│  ├─ Retained size computation (O(V) bottom-up)                   │
│  ├─ Leak suspect detection (4-phase heuristic)                   │
│  ├─ Class histogram aggregation                                   │
│  ├─ Waste analysis (duplicate strings + empty collections)       │
│  └─ GC root path computation (BFS backward traversal)           │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Design Decisions

### Why a Subprocess Instead of WASM or Native Module?

Heap analysis is CPU-intensive and memory-intensive. A subprocess provides:

1. **Isolation** — The analysis server can use multi-GB of RAM without affecting VS Code's process
2. **Concurrency** — Rust's async runtime (tokio) handles I/O while blocking tasks handle computation
3. **Portability** — The same binary works for VS Code, IntelliJ (future), and MCP clients
4. **Crash resilience** — If the analysis server crashes on a corrupted file, VS Code stays responsive

### Why JSON-RPC 2.0?

JSON-RPC is a simple, well-specified protocol that maps naturally to request/response and notification patterns:

- **Request/Response** — `get_children`, `export_json`, `gc_root_path`
- **Async Notification** — `analyze_heap` returns immediately with `"processing"`, then sends `heap_analysis_complete` notification when done
- **Human-readable** — Easy to debug by logging stdin/stdout

### Why Memory-Mapped I/O?

HPROF files can be multiple gigabytes. Memory mapping (`mmap`) provides:

- **Zero-copy access** — The OS loads pages on demand; no need to read the entire file into RAM
- **Efficient random access** — The `jvm-hprof` parser can jump to any record without sequential reads
- **OS-level optimization** — The page cache is shared; multiple analyses of the same file reuse cached pages

## Process Lifecycle

```
User opens .hprof file
    │
    ▼
HprofEditorProvider.resolveCustomEditor()
    │
    ├─ Spawns hprof-server subprocess
    ├─ Creates RustClient (JSON-RPC wrapper)
    ├─ Sends analyze_heap request with file path
    │
    ▼
hprof-server receives request
    │
    ├─ Returns { status: "processing" } immediately
    ├─ Spawns blocking task (tokio::task::spawn_blocking)
    │   ├─ Memory-map HPROF file
    │   ├─ Build heap graph (2 passes)
    │   ├─ Compute dominator tree
    │   ├─ Compute retained sizes
    │   ├─ Detect leak suspects
    │   ├─ Build histogram
    │   └─ Compute waste analysis
    │
    ▼
Blocking task completes
    │
    ├─ Sends heap_analysis_complete notification
    │   (top_objects, summary, histogram, leak_suspects, waste_analysis)
    │
    ▼
HprofEditorProvider receives notification
    │
    ├─ Caches AnalysisData in per-editor state
    ├─ Posts data to webview
    │
    ▼
Webview renders all 7 tabs
    │
    ├─ User clicks tree node → getChildren message
    │   → Extension → RustClient → get_children RPC → response → webview update
    │
    ├─ User asks AI question → chatMessage message
    │   → Extension → LLM API (streaming) → webview update
    │
    └─ User closes editor tab
        → webview disposed → RustClient.dispose() → hprof-server process killed
```
