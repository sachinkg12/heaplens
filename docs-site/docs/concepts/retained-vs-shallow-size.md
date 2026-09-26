---
sidebar_position: 3
title: Retained vs. Shallow Size
---

# Retained vs. Shallow Size

These two metrics appear in every tab of HeapLens. Understanding the difference is essential for interpreting heap analysis results.

## Shallow Size

**Shallow size** is the memory consumed by the object itself — its header and field data, nothing more.

Every Java object has:
- An **object header** (typically 12-16 bytes): stores the class pointer, hash code, and GC metadata
- **Field data**: the primitive values and reference pointers declared by the class

HeapLens estimates these sizes from the dump. Its shared model includes headers,
reference slots and alignment, and infers reference width separately from class-pointer
width. The Overview labels the model as an estimate. HPROF does not encode every
field offset, hidden VM field or special padding rule; class metadata is excluded.
Android dumps currently retain the earlier payload-only estimate.

For example, with a 12-byte header, 4-byte references and 8-byte alignment:

```java
class User {
    String name;      // 4 bytes under this layout
    int age;          // 4 bytes
    boolean active;   // 1 byte
}
// Shallow size ≈ 12 + 4 + 4 + 1, rounded to 8 bytes = 24 bytes
```

Under this layout, the shallow size of a `User` is approximately 24 bytes regardless of how long the `name` string is. The `String` object and its backing array are separate objects with their own shallow sizes. Other JVM layouts can produce different sizes.

### Array Shallow Sizes

Arrays include the header plus the element data. With a 16-byte array header,
4-byte references and 8-byte object alignment:

```
byte[1000]  → 16 (header) + 1000 (data) + padding = ~1016 bytes
int[1000]   → 16 (header) + 4000 (data) = 4016 bytes
Object[100] → 16 (header) + 400 (100 × 4-byte refs) = 416 bytes
```

## Retained Size

When comparing dumps, analyze both with the same HeapLens version and sizing model.
Earlier releases counted serialized payload bytes; changes from those releases can
reflect corrected accounting rather than application growth.

**Retained size** is the total memory that would be freed if this object were garbage collected. It includes the object's shallow size plus the shallow sizes of all objects that are *only* reachable through this object.

This is computed from the [Dominator Tree](./dominator-tree): a node's retained size equals its shallow size plus the sum of retained sizes of all its children in the dominator tree.

### Example

```
HashMap (shallow: 48 bytes)
  └─ Node[] (shallow: 8016 bytes)
       ├─ Node (shallow: 32 bytes)
       │    ├─ String "key1" (shallow: 24 bytes)
       │    │    └─ byte[] (shallow: 56 bytes)
       │    └─ BigObject (shallow: 64 bytes)
       │         └─ byte[1MB] (shallow: 1,048,592 bytes)
       └─ ... (more nodes)
```

| Object | Shallow Size | Retained Size |
|--------|-------------|---------------|
| `byte[1MB]` | 1,048,592 | 1,048,592 (leaf node, no children) |
| `BigObject` | 64 | 1,048,656 (64 + 1,048,592) |
| `String "key1"` | 24 | 80 (24 + 56) |
| `Node` | 32 | 1,048,768 (32 + 80 + 1,048,656) |
| `Node[]` | 8,016 | 1,056,784+ (8,016 + all nodes) |
| `HashMap` | 48 | 1,056,832+ (48 + entire tree below) |

The HashMap's shallow size is only 48 bytes. But its retained size could be gigabytes — because collecting the HashMap would also collect its entire backing array, every entry, every key, and every value.

## How HeapLens Computes Retained Sizes

HeapLens uses a single-pass bottom-up traversal of the dominator tree:

1. **Initialize** every node's retained size to its shallow size
2. Process nodes from leaves to root (reverse topological order)
3. For each node: `retained_size += sum(child.retained_size for each child in dominator tree)`

This is O(V) — linear in the number of objects. For a 200 MB heap dump with 3 million objects, this completes in under a second.

## Interpreting the Numbers

| Scenario | What it tells you |
|---------|-------------------|
| High retained, low shallow | The object is a "gatekeeper" — it keeps a large subgraph alive through its references |
| High retained, high shallow | The object is large itself *and* keeps other objects alive (e.g., a big byte[] that is the sole content of a cache entry) |
| High shallow, low retained | The object is large but others also reference its children — removing it alone wouldn't free much |
| Many objects with small retained | Distributed memory — no single bottleneck, may indicate a class-level issue (see Histogram) |

## Shared References and the Dominator Boundary

If two objects both reference a third, that third object is *not* in the retained set of either one — it's retained by their common dominator (further up the tree).

```
    Controller
    ├─→ ServiceA ─→ SharedConfig
    └─→ ServiceB ─→ SharedConfig
```

`SharedConfig` is retained by `Controller` (their common dominator), not by `ServiceA` or `ServiceB`. Neither service's retained size includes `SharedConfig`. This is correct — collecting `ServiceA` alone would not free `SharedConfig` because `ServiceB` still references it.

This is why retained sizes sometimes look smaller than expected — shared objects are attributed to the closest common ancestor in the dominator tree.
