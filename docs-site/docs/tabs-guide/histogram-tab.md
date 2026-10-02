---
sidebar_position: 2
title: Histogram Tab
---

# Histogram Tab

The Histogram tab shows a class-level aggregation of memory usage. While the Overview tab shows individual objects, the Histogram groups all instances of the same class together, answering: **"Which classes consume the most memory in aggregate?"**

## What You See

A searchable, sortable table with every class in the heap:

```
Class Name                          Instances   Shallow      Retained
byte[]                              1,245,678   890.20 MB    890.20 MB
java.lang.String                    845,312     32.20 MB     142.50 MB
java.util.HashMap$Node              612,000     23.40 MB     580.00 MB
char[]                              823,100     62.10 MB     62.10 MB
com.example.model.User              45,000      6.87 MB      312.50 MB
java.util.HashMap                   12,400      580 KB       245.10 MB
java.lang.Object[]                  8,200       12.30 MB     12.30 MB
...
```

### Column Definitions

| Column | Meaning |
|--------|---------|
| **Class Name** | Fully-qualified Java class name (e.g., `java.util.HashMap$Node`) |
| **Instances** | Number of objects of this class on the heap |
| **Shallow Size** | Sum of shallow sizes of all instances of this class |
| **Retained Size** | Aggregate retained size with overlapping retained subtrees within the same class counted once |
| **% of Heap** | Class retained size divided by the dump's reachable heap size, multiplied by 100 |

Retained sets can overlap **between different classes**. Their percentages therefore need not sum to 100%; they are not slices of a pie chart. Filtering, sorting and Show all do not change the denominator. If reachable heap is zero or unavailable, the percentage is shown as `N/A`, not calculated using total heap or summed class sizes.

**Export CSV** uses the same percentages as the table and exports every matching row in the current sort order, not just the first 200 displayed rows. Column names are unchanged; an unavailable percentage is exported as `N/A`.

## Interactions

### Sorting

Click any column header to sort. Click again to toggle ascending/descending. The default sort is by **Retained Size** (descending).

Useful sort orders:

- **Retained Size** (default) — finds the classes that dominate memory
- **Instances** — finds the most frequently allocated classes
- **Shallow Size** — finds classes with the largest per-instance footprint

### Search / Filter

Type in the search box to filter classes by name (case-insensitive). Examples:

- Type `HashMap` to see all HashMap-related classes
- Type `com.example` to isolate your application's classes from JDK classes
- Type `[]` to see only array types

### Pagination

The first 200 rows are rendered immediately. If there are more classes, a "Show all N classes" button appears at the bottom. Click it to render the full list.

## How to Interpret the Histogram

### Pattern 1: `byte[]` at the top

`byte[]` is almost always the #1 class by shallow size because strings, serialized data, I/O buffers, and many caches store data as byte arrays. If `byte[]` retained size is very high, ask: **"What objects hold references to these byte arrays?"** — switch to the Dominator Tree to find out.

### Pattern 2: Large Instance Count, Small Retained Per Instance

```
com.example.model.Order    500,000 instances    25 MB shallow    25 MB retained
```

500,000 orders at 50 bytes each — this is normal if you expect that many orders. But if your application should only hold the last 100 orders in memory, 500,000 suggests a leak or missing eviction.

### Pattern 3: High Retained vs. Shallow Ratio

```
java.util.HashMap          12,400    580 KB shallow    245 MB retained
```

12,400 HashMaps collectively retain 245 MB but have only 580 KB of their own data. The retained memory is in their entries, keys, and values. A few of those 12,400 maps are probably very large — switch to the Dominator Tree to find which ones.

### Pattern 4: Application vs. JDK Classes

Filter by your package prefix (`com.example`) to see only your classes:

```
com.example.cache.CacheEntry    120,000    18.3 MB    186.0 MB
com.example.model.User          45,000     6.87 MB     45.0 MB
com.example.dto.Response        32,000     3.05 MB     64.0 MB
```

This immediately tells you your application's biggest memory consumers, separated from JDK infrastructure.

## Example Walkthrough

You're investigating an OOM in a data processing service.

**Step 1:** Open the Histogram tab. Sort by **Instances** (descending).

```
java.lang.String      2,400,000 instances
byte[]                1,800,000 instances
com.example.Record    1,200,000 instances   ← unusual
java.util.HashMap$Node  900,000 instances
```

**Step 2:** 1.2 million `Record` instances is suspicious for a service that processes records one at a time and should discard them.

**Step 3:** Search for `Record` in the filter box:

```
com.example.Record         1,200,000    183 MB    420 MB
com.example.RecordField        —        (inside Record)
```

**Step 4:** Switch to the Dominator Tree tab to find *what holds 1.2 million Records alive*. Or go to the Leak Suspects tab — HeapLens likely flagged `Record` as a class-level suspect ("1,200,000 instances of com.example.Record collectively retain 25.8% of heap").
