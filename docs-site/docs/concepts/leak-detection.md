---
sidebar_position: 5
title: Leak Detection Algorithm
---

# Leak Detection Algorithm

HeapLens uses a multi-phase heuristic algorithm to automatically identify memory leak suspects. The approach adapts established heap-analysis heuristics with classloader-aware analysis and accumulation point detection.

## Design Philosophy

A "leak suspect" is not necessarily a bug — it is an object or class that retains a disproportionate share of the heap. The algorithm flags anything retaining more than a threshold percentage of the **reachable heap** (objects actually reachable from GC roots, excluding unreachable garbage awaiting collection).

The threshold is intentionally conservative: the goal is to surface the 3-5 most significant memory holders, not to flag everything.

## The Four Phases

### Phase 1: Classloader Suspects

**Goal:** Identify component-level leaks by finding classloaders that retain large memory subtrees.

In enterprise Java applications, each deployed component (WAR, OSGi bundle, plugin) typically has its own classloader. A leaked classloader keeps its entire component alive — all classes, static fields, and objects.

**Algorithm:**
1. Collect all classloader object IDs from `LoadClass` records in the HPROF file
2. For each classloader instance, check its retained size in the dominator tree
3. If `retained_size > 5% of reachable_heap_size`, flag as a suspect

**Example output:**
> **[HIGH] org.apache.catalina.loader.WebappClassLoader** — retains 68.2% of heap (1.36 GB)

This typically indicates a classloader leak in a web application — a web app was undeployed but its classloader was not garbage collected due to a lingering reference.

### Phase 2: Accumulation Point Discovery

**Goal:** For each classloader suspect, find the specific object where memory "fans out" from a linear chain into a wide structure.

**Algorithm:**
1. Start at the classloader node in the dominator tree
2. Walk down the tree, always following the child with the largest retained size
3. At each step, check: does the largest child retain **more than 80%** of the current node's retained size?
   - **Yes** → continue walking (this is a pass-through node, not the real accumulation point)
   - **No** → stop — this node is the **accumulation point** where memory fans out to many children
4. Report the accumulation point in the suspect's description

**Visual intuition:**

```
ClassLoader (1.36 GB)         ← Phase 1 catches this
  └─ AppContext (1.35 GB)     ← pass-through (99% flows to one child)
      └─ CacheManager (1.34 GB) ← pass-through
          └─ HashMap (1.32 GB)   ← ACCUMULATION POINT (children are many small entries)
              ├─ Entry (2.1 MB)
              ├─ Entry (1.9 MB)
              └─ ... (650 entries)
```

**Example output:**
> Memory accumulated in HashMap (1.32 GB) containing 650 entries

### Phase 3: Non-Classloader Individual Suspects

**Goal:** Find large individual objects (Instance or Array) not already covered by classloader suspects.

**Algorithm:**
1. Scan all nodes with `retained_size > 5% of reachable_heap_size`
2. For each candidate, walk up the dominator tree — if any ancestor is already a Phase 1 suspect, skip it (already reported)
3. Filter pass-throughs: if a node's largest child retains >90% of the node's retained size, skip it (the child is the real suspect, not this node)
4. Sort by retained size, take top 10

**Example output:**
> **[MEDIUM] java.util.concurrent.ConcurrentHashMap** — retains 12.3% of heap (246 MB)
> *Single ConcurrentHashMap instance retains 12.3% of reachable heap*

### Phase 4: Class-Level Aggregates

**Goal:** Catch cases where no single object is huge, but many instances of the same class collectively consume significant memory.

**Algorithm:**
1. For each class in the histogram with `total_retained_size > 10% of reachable_heap_size` AND `instance_count > 1`
2. Check if this class is already covered by a Phase 1-3 suspect
3. If not, report as a class-level suspect

**Example output:**
> **[MEDIUM] com.example.model.UserSession** — 45,000 instances collectively retain 15.2% of heap (304 MB)

This catches the scenario where no single `UserSession` is large, but 45,000 of them collectively dominate the heap.

## Severity Classification

| Severity | Condition | Visual |
|----------|-----------|--------|
| **HIGH** | Retained percentage > 30% | Red card |
| **MEDIUM** | Retained percentage 5-30% | Orange card |

Objects below 5% are not reported — they are within normal operating range.

## Reachable Heap Size

All percentages are computed against the **reachable heap size**, not the total heap size. The reachable heap size excludes objects that have no path from any GC root — these are effectively garbage awaiting collection.

```
reachable_heap_size = total_heap_size - unreachable_shallow_size
```

When comparing percentages with an independent reference analyzer, verify that both analyses use the same reachable-heap definition and denominator.

## Worked Example

Given a 500 MB heap dump:

| Phase | Suspect | Retained | % | Reason |
|-------|---------|----------|---|--------|
| 1 | `WebappClassLoader` | 340 MB | 68% | Classloader for leaked web app |
| 2 | (accumulation point) | — | — | `HashMap` inside `SessionManager` |
| 3 | `LogBuffer` | 85 MB | 17% | Single log buffer not flushed |
| 4 | `byte[]` | 60 MB | 12% | 15,000 byte arrays from deserialization |

**Interpretation:** The web app classloader is the primary leak (68%). The log buffer and byte arrays are secondary — fix the classloader leak first, then investigate whether the log buffer needs a size cap.
