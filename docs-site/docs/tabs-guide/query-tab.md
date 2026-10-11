---
sidebar_position: 7
title: Query
---

HeapQL is a read-only SQL-like language plus object navigation commands. Use highlighting, autocomplete, help, result tables, and history to investigate the same analyzed dump.

```heapql
SELECT object_id, class_name, shallow_size, retained_size
FROM instances
WHERE retained_size > 1MB
ORDER BY retained_size DESC
LIMIT 20
```

## Tables and counting

Supported tables: instances, class_histogram, dominator_tree, leak_suspects. `FROM objects` is not valid.

```heapql
SELECT COUNT(*) AS class_rows, SUM(instance_count) AS instances
FROM class_histogram
```

COUNT counts rows; in the histogram it counts classes, not instances. SUM(instance_count) totals recorded instances. Retained sizes can overlap: SUM(retained_size) is not whole-heap live usage.

LIKE '%Cache%' matches names, not every HashMap used as a cache. Inspect semantics and actual owners.

## Results and navigation

Use current host page controls when supplied. The paged API separates page size from SQL LIMIT; not every released renderer exposes identical Prev/Next buttons. Query history can repopulate/run saved text according to host controls—inspect it before execution. History persistence differs by host; avoid storing secrets in queries.

Object navigation commands `:path`, `:refs`, `:children`, and `:info` take an ID from this dump. Unknown objects/errors should remain visible without replacing valid results with fabricated rows.

## Cost and limitations

LIMIT bounds returned rows, not necessarily scanning, sorting, join materialization, or graph memory. Use filters, bounded output, and a safe dump first. Query errors may differ in wording by host. Server Retry must restore query routing.

See the [complete reference](../api-reference/heapql.md) for JOINs, GROUP BY, aggregates, subqueries, binary size literals, special dominator-table semantics, and unsupported syntax.
