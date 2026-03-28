---
sidebar_position: 2
title: Dominator Tree
---

# Dominator Tree

The dominator tree is the single most important data structure in heap analysis. It answers the question: **"If this object were garbage collected, what else would be freed?"**

## The Problem with Raw Object Graphs

Java heap dumps contain millions of objects connected by millions of references. The raw object graph is a directed graph with cycles, shared references, and complex topology. Navigating it directly is impractical — you need a simplified view that preserves the essential ownership relationships.

## Definition

A node **D dominates** node **N** if every path from the GC roots to N passes through D. In other words, if D were removed, N would become unreachable.

The **immediate dominator** of N is the unique dominator of N that is closest to N (and is itself dominated by all other dominators of N). Every node except the root has exactly one immediate dominator.

These immediate dominator relationships form a tree — the **dominator tree**.

## Visual Example

Consider this object graph:

```
     GC Root
     ├─→ A
     │   ├─→ C
     │   └─→ D
     └─→ B
         └─→ D    (B also references D)
```

Object `D` is reachable through two paths: `Root → A → D` and `Root → B → D`. Since removing `A` alone does not make `D` unreachable (it's still reachable through `B`), **A does not dominate D**. Similarly, B does not dominate D.

Only the GC Root dominates D (because removing the root makes everything unreachable).

The dominator tree looks like:

```
GC Root
├── A
│   └── C    (only reachable through A)
├── B
└── D        (reachable through both A and B, so dominated by Root)
```

Notice: `C` is under `A` because the only path to `C` goes through `A`. But `D` is directly under the root because it has two independent paths.

## Why This Matters for Memory Analysis

The dominator tree converts the complex reference graph into a **tree of ownership**:

- Each node's **retained size** equals its own shallow size plus the retained sizes of everything below it in the dominator tree.
- If you delete a node, everything in its subtree becomes garbage-collectible.
- The tree clearly shows which single object or component is responsible for keeping large amounts of memory alive.

### Practical Example

Suppose you have an application with a `SessionManager`:

```
Dominator Tree:
SessionManager               — 850 MB retained
  └─ ConcurrentHashMap        — 848 MB retained
      └─ Node[]               — 846 MB retained
          ├─ Session #1        — 4.2 MB retained
          │   ├─ User          — 2.1 MB
          │   └─ ShoppingCart  — 1.8 MB
          ├─ Session #2        — 3.9 MB retained
          └─ ... (200,000 sessions)
```

Reading this tree tells you:

1. `SessionManager` is responsible for 850 MB
2. The memory is in a `ConcurrentHashMap` → 200,000 session entries
3. Each session holds ~4 MB (User + ShoppingCart)
4. **Action:** The sessions are not being expired — add a TTL or size limit

Without the dominator tree, you would see 200,000 `Session` objects and 200,000 `User` objects scattered in a flat list with no structural insight.

## Algorithm

HeapLens computes dominators using the **Lengauer-Tarjan algorithm** on CSR (Compressed Sparse Row) edge storage. This is the same algorithm used by Eclipse MAT, YourKit, and other production heap analyzers.

**Complexity:** O(E * α(V)), where E is the number of edges (references), V is the number of nodes (objects), and α is the inverse Ackermann function (effectively constant). For a heap with 5 million objects and 20 million references, this runs in a few seconds.

**Steps in HeapLens:**

1. Build the object graph with a synthetic SuperRoot connected to all GC roots
2. Run Lengauer-Tarjan to compute the immediate dominator of every node
3. Build a children map from the dominator relationships
4. Compute retained sizes bottom-up (leaves first, then parents)

## Relationship to Other Tools

| Tool | Dominator Algorithm |
|------|-------------------|
| Eclipse MAT | Lengauer-Tarjan |
| YourKit | Custom iterative |
| VisualVM | Simple DFS-based |
| HeapLens | Lengauer-Tarjan (on CSR edge storage) |

HeapLens matches Eclipse MAT's approach for maximum accuracy and comparability.
