---
sidebar_position: 2
title: Quick Start
---

# Quick Start

This guide takes you from zero to analyzing your first heap dump in under five minutes.

## Step 1: Open a Heap Dump

After launching the Extension Development Host (F5), open any `.hprof` file:

- **Drag and drop** a `.hprof` file into VS Code, or
- Use **Command Palette** (`Cmd+Shift+P`) and type `HeapLens: Analyze HPROF File`, then select a file

HeapLens registers as a custom editor for `.hprof` files — opening one automatically triggers analysis.

## Step 2: Wait for Analysis

A progress notification appears while the Rust backend processes your file:

```
Step 1/3: Loading HPROF file...
Step 2/3: Building heap graph...
Step 3/3: Calculating dominators and retained sizes...
```

Analysis time depends on file size:

| Heap Dump Size | Approximate Time |
|---------------|-----------------|
| &lt; 50 MB | &lt; 1 second |
| 50-200 MB | 1-2 seconds |
| 200 MB - 1 GB | 2-5 seconds |
| 1-2 GB | ~1-2 seconds |
| > 2 GB | ~10 seconds (tested up to 14 GB) |

## Step 3: Explore the Results

Once analysis completes, a tabbed interface appears with seven tabs:

1. **Overview** — High-level stats and a pie chart of top memory consumers
2. **Histogram** — Every class ranked by memory consumption
3. **Dominator Tree** — Drill into the retention hierarchy to see *what holds what*
4. **Leak Suspects** — Automatically detected objects retaining disproportionate memory
5. **Waste** — Duplicate strings and empty collections that waste memory
6. **Source** — Map classes to your project source code
7. **AI Chat** — Ask questions about the heap in natural language

## Step 4: Interpret Results

Here is a typical workflow for diagnosing a memory issue:

### Start with Leak Suspects

Open the **Leak Suspects** tab. Each card shows a class that retains a large percentage of the heap. For example:

> **[HIGH] com.example.cache.SessionCache** — retains 42.1% of heap (512.00 MB)
> *Single SessionCache instance retains 42.1% of reachable heap*

This tells you a single `SessionCache` object is keeping 512 MB alive.

### Drill into the Dominator Tree

Switch to the **Dominator Tree** tab and expand `SessionCache`. You might see:

```
SessionCache             — 512 MB retained
  └─ HashMap             — 508 MB retained
      ├─ HashMap$Node[]  — 500 MB retained
      │   ├─ UserSession — 12 MB retained
      │   ├─ UserSession — 11 MB retained
      │   └─ ...         (2,400 more entries)
      └─ ...
```

This reveals the cache holds 2,400+ `UserSession` objects through a `HashMap`.

### Check Waste

The **Waste** tab might show:

> **Duplicate Strings:** 45.2 MB (8.8% of heap)
> - `"ACTIVE"` x12,400 — wastes 1.2 MB
> - `"application/json"` x8,200 — wastes 0.8 MB

These are identical String instances that could be deduplicated with `String.intern()` or a constant.

## Step 5: Export or Report

- **Export JSON**: Command Palette → `HeapLens: Export Analysis as JSON`
- **Incident Report**: Click the report button in the webview to copy a markdown summary to your clipboard

## What's Next

- Read [Heap Dump Fundamentals](../concepts/heap-dump-fundamentals) to understand the theory
- Explore each tab in detail in the [Tabs Guide](../tabs-guide/overview-tab)
- Set up [MCP integration](../mcp/introduction) to analyze heaps from Claude Desktop
