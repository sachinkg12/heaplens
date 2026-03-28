---
sidebar_position: 7
title: Query Tab
---

# Query Tab

The Query tab provides HeapQL, a SQL-like query language for ad-hoc interrogation of Java heap dumps. Instead of navigating through tabs and clicking through trees, you write declarative queries to extract exactly the data you need — filter by class name, sort by retained size, drill into specific objects, and trace GC root paths, all from a single text input.

## What You See

A query input area with action buttons, a history strip, and a results table:

```
┌──────────────────────────────────────────────────────────────────────┐
│  SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 10 │
│                                                                      │
│                                                                      │
│                                                    ┌─────┐  ┌───┐   │
│                                                    │ Run │  │ ? │   │
│                                                    └─────┘  └───┘   │
└──────────────────────────────────────────────────────────────────────┘
  10 rows returned (10 matched, 842 scanned, 2.3ms)

  ┌──────────────────────┐ ┌──────────────────────────────┐ ┌─────────┐
  │ SELECT * FROM class… │ │ :info 12345                  │ │ :path … │
  └──────────────────────┘ └──────────────────────────────┘ └─────────┘

  class_name                          instance_count  shallow_size  retained_size
  byte[]                              1,245,678       890.20 MB     890.20 MB
  java.lang.String                    845,312         32.20 MB      142.50 MB
  java.util.HashMap$Node              612,000         23.40 MB      580.00 MB
  char[]                              823,100         62.10 MB      62.10 MB
  com.example.model.User              45,000          6.87 MB       312.50 MB
  ...
```

### UI Elements

| Element | Description |
|---------|-------------|
| **Query input** | Multi-line textarea for typing HeapQL queries or special commands |
| **Run button** | Executes the current query (keyboard shortcut: `Ctrl+Enter` / `Cmd+Enter`) |
| **Help button (?)** | Toggles the inline HeapQL reference card |
| **Status bar** | Shows row count, matched count, scanned count, and execution time |
| **History chips** | Clickable chips of recent queries (up to 10); click to re-populate the input |
| **Results table** | Dynamic table with columns matching the query; size columns are right-aligned and human-formatted |

## Available Tables

HeapQL exposes four virtual tables that map to the data computed by the Rust analysis engine:

| Table | Columns | Description |
|-------|---------|-------------|
| `instances` | `object_id`, `node_type`, `class_name`, `shallow_size`, `retained_size` | Every object on the heap. Use WHERE/LIMIT to avoid scanning millions of rows. |
| `class_histogram` | `class_name`, `instance_count`, `shallow_size`, `retained_size` | Class-level aggregation — one row per class with summed sizes and instance counts. |
| `dominator_tree` | `object_id`, `node_type`, `class_name`, `shallow_size`, `retained_size` | Same schema as `instances`; queries the dominator tree. Use `WHERE object_id = X` to focus on a specific subtree. |
| `leak_suspects` | `class_name`, `object_id`, `retained_size`, `retained_percentage`, `description` | Automatically detected leak suspects with severity descriptions. |

### Choosing the Right Table

- **"What classes use the most memory?"** — query `class_histogram`
- **"Show me all objects of class X"** — query `instances` with a WHERE filter
- **"What does object X dominate?"** — query `dominator_tree` with a WHERE filter, or use `:children <id>`
- **"Are there any detected leaks?"** — query `leak_suspects`

## SQL Syntax

```sql
SELECT [columns | *] FROM table [WHERE conditions] [ORDER BY column [ASC | DESC]] [LIMIT n]
```

All clauses except `SELECT` and `FROM` are optional. Keywords are case-insensitive (`select`, `SELECT`, and `Select` all work).

### Column Selection

```sql
-- All columns
SELECT * FROM class_histogram

-- Specific columns
SELECT class_name, retained_size FROM class_histogram

-- Columns must exist in the target table
SELECT instance_count FROM instances   -- Error: unknown column
```

### WHERE Clause

Filter rows using conditions on any column in the table.

**Comparison operators:**

| Operator | Meaning | Example |
|----------|---------|---------|
| `=` | Equal to | `class_name = 'java.util.HashMap'` |
| `!=` | Not equal to | `node_type != 'Array'` |
| `>` | Greater than | `retained_size > 1048576` |
| `<` | Less than | `shallow_size < 1024` |
| `>=` | Greater than or equal | `instance_count >= 1000` |
| `<=` | Less than or equal | `retained_percentage <= 5.0` |
| `LIKE` | Pattern match (case-insensitive) | `class_name LIKE '%Cache%'` |

**LIKE wildcards:**

| Pattern | Matches |
|---------|---------|
| `'%Cache%'` | Class name contains "Cache" anywhere |
| `'com.example%'` | Class name starts with "com.example" |
| `'%Map'` | Class name ends with "Map" |
| `'java.util.HashMap'` | Exact match (no wildcards) |

**Combining conditions with AND / OR:**

```sql
-- Both conditions must be true
SELECT * FROM instances
WHERE class_name LIKE '%Cache%' AND retained_size > 1048576

-- Either condition can be true
SELECT * FROM class_histogram
WHERE instance_count > 10000 OR retained_size > 104857600
```

### ORDER BY

Sort results by any column. Default direction is ascending; append `DESC` for descending.

```sql
-- Largest retained size first
SELECT * FROM class_histogram ORDER BY retained_size DESC

-- Alphabetical by class name
SELECT * FROM class_histogram ORDER BY class_name ASC
```

### LIMIT

Cap the number of returned rows. Essential when querying `instances` (which can contain millions of rows).

```sql
-- Top 20 classes by retained size
SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 20
```

### Column Aliases

Use `AS` to rename columns in the result set. Aliases work on both plain columns and aggregate expressions, and can be referenced in `ORDER BY`.

```sql
-- Alias plain columns
SELECT class_name AS name, retained_size AS total FROM class_histogram

-- Alias aggregate expressions
SELECT COUNT(*) AS instance_count, SUM(retained_size) AS total_retained
FROM class_histogram
GROUP BY class_name
ORDER BY total_retained DESC LIMIT 10

-- Aliases are reflected in the results table header
SELECT class_name AS cls, instance_count AS count
FROM class_histogram
ORDER BY count DESC LIMIT 5
```

### Unsupported Features

The following SQL features are **not supported** and will return a clear error message if used:

| Feature | Status |
|---------|--------|
| `RIGHT JOIN` | Not supported |
| `FULL JOIN` | Not supported |
| `CROSS JOIN` | Not supported |

Only `INNER JOIN` and `LEFT JOIN` are supported for combining tables.

## Special Commands

HeapQL supports four special commands for object-level inspection. These bypass SQL parsing and operate directly on object IDs obtained from previous queries.

| Command | Description | Output Columns |
|---------|-------------|----------------|
| `:path <id>` | Shortest GC root path to the object | `object_id`, `node_type`, `class_name`, `shallow_size`, `retained_size` |
| `:refs <id>` | All objects that hold a reference to this object | `object_id`, `node_type`, `class_name`, `shallow_size`, `retained_size` |
| `:children <id>` | Immediate children in the dominator tree | `object_id`, `node_type`, `class_name`, `shallow_size`, `retained_size` |
| `:info <id>` | Detailed information about a single object | `object_id`, `node_type`, `class_name`, `shallow_size`, `retained_size`, `child_count`, `referrer_count` |

### Using Special Commands

```
:info 48291
```

Returns a single row with the object's class, sizes, dominator child count, and referrer count. Use this to get a quick summary before deciding whether to explore children or trace the GC root path.

```
:path 48291
```

Returns the reference chain from GC roots to the object, one row per hop. Read top-to-bottom: the first row is the GC root, and the last row is the target object.

```
:refs 48291
```

Returns every object that points to the target. Useful for answering "who is keeping this alive?" when the dominator tree alone does not tell the full story (e.g., objects with multiple incoming references).

```
:children 48291
```

Returns the immediate children of the object in the dominator tree — equivalent to clicking the expand triangle in the Dominator Tree tab.

## Example Queries

### 1. Top 10 Classes by Retained Size

```sql
SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 10
```

The most common starting point. Shows which classes dominate heap memory in aggregate. If a single application class appears near the top, it is a strong candidate for investigation.

### 2. Find All Cache-Related Objects

```sql
SELECT * FROM instances
WHERE class_name LIKE '%Cache%'
ORDER BY retained_size DESC LIMIT 20
```

Searches for any object whose class name contains "Cache" — catches `HashMap` used as caches, Guava `LoadingCache`, Caffeine caches, and custom cache classes. Sorting by retained size surfaces the largest caches first.

### 3. Classes With More Than 100,000 Instances

```sql
SELECT class_name, instance_count, retained_size
FROM class_histogram
WHERE instance_count > 100000
ORDER BY instance_count DESC
```

High instance counts often indicate a leak or an unbounded collection. If a business object (`com.example.model.Order`) has 500,000 instances, something is preventing garbage collection.

### 4. Leak Suspects Retaining Over 10%

```sql
SELECT class_name, retained_percentage, retained_size, description
FROM leak_suspects
WHERE retained_percentage > 10
ORDER BY retained_percentage DESC
```

Filters the auto-detected leak suspects to show only the most severe ones. The `description` column provides a human-readable explanation generated by the detection algorithm.

### 5. Inspect a Specific Object and Trace Its Root Path

```sql
-- Step 1: Find a suspicious object
SELECT object_id, class_name, retained_size FROM instances
WHERE class_name LIKE '%SessionManager%'
ORDER BY retained_size DESC LIMIT 5
```

```
-- Step 2: Get detailed info (using the object_id from step 1)
:info 78432
```

```
-- Step 3: Trace the GC root path
:path 78432
```

```
-- Step 4: See what it retains
:children 78432
```

A typical investigation flow: find the object, inspect it, trace why it is alive, and see what memory it holds.

### 6. Large Byte Arrays (Potential Buffer Leaks)

```sql
SELECT object_id, class_name, shallow_size, retained_size
FROM instances
WHERE class_name = 'byte[]' AND shallow_size > 1048576
ORDER BY shallow_size DESC LIMIT 10
```

Finds `byte[]` instances larger than 1 MB. Large byte arrays are often I/O buffers, serialized data, or image data. If many exist, check for unclosed streams or unbounded read buffers.

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` (Windows/Linux) | Execute the current query |
| `Cmd+Enter` (macOS) | Execute the current query |

The shortcut works while the cursor is inside the query input textarea.

## Query Results

The results table formats values for readability:

- **Size columns** (`shallow_size`, `retained_size`) are displayed in human-readable units (e.g., `245.10 MB` instead of `257039769`)
- **Percentage columns** (`retained_percentage`) are displayed with one decimal place and a `%` suffix
- **Numeric columns** (`instance_count`, `object_id`) use thousands separators
- **String columns** (`class_name`, `description`) are displayed as-is

The status bar above the results table shows execution metadata:

```
10 rows returned (10 matched, 842 scanned, 2.3ms)
```

| Metric | Meaning |
|--------|---------|
| **rows returned** | Number of rows in the result set (after LIMIT) |
| **matched** | Total rows matching the WHERE clause (before LIMIT) |
| **scanned** | Total rows examined by the query engine |
| **time** | Wall-clock execution time in milliseconds |

## Tips

- **Always use LIMIT on `instances`** — the instances table can contain millions of rows. Without a LIMIT, the query will scan every object and the results table may be very large.
- **Use `class_histogram` for exploration** — it has one row per class (typically hundreds to low thousands), so queries are fast even without LIMIT.
- **Pipe results into special commands** — find an `object_id` with a SELECT query, then use `:info`, `:path`, `:refs`, or `:children` to investigate further.
- **Query history persists within the session** — click any history chip to re-run a previous query. History holds the 10 most recent unique queries, with the latest first.
- **LIKE is case-insensitive** — `LIKE '%hashmap%'` matches `java.util.HashMap`. No need to worry about capitalization.
