---
title: HeapQL language reference
---

HeapQL is a read-only, limited SQL-like language—not a full SQL database. It operates on the completed analysis and offers object-navigation commands. Example IDs are placeholders.

## Tables

| Table | Columns / special semantics |
| --- | --- |
| instances | object_id, node_type, class_name, shallow_size, retained_size |
| class_histogram | class_name, instance_count, shallow_size, retained_size |
| dominator_tree | Object columns; WHERE object_id = X is a **child-drill filter**, not ordinary row selection |
| leak_suspects | class_name, object_id, retained_size, retained_percentage, description |

Use `:info X` / instances to inspect the selected object itself. FROM objects is unsupported. Sizes are bytes; retained values may overlap.

## SELECT and filters

```heapql
SELECT object_id, class_name, retained_size
FROM instances
WHERE class_name LIKE '%Cache%' AND retained_size >= 1MB
ORDER BY retained_size DESC
LIMIT 20
```

Supported comparisons: `=`, `!=`, `>`, `<`, `>=`, `<=`, and LIKE with % wildcard. AND/OR and supported parentheses combine conditions. Strings use single quotes. Name matching does not detect every object playing that role.

Integer byte literals support B, KB, MB, GB with **binary** factors (KB = 1024). Keywords are case-insensitive. Use exact column names and inspect aliases in returned headings. ORDER BY accepts a column/aggregate alias and ASC/DESC. LIMIT limits output, not necessarily work.

## Aggregates and grouping

COUNT, SUM, AVG, MIN, MAX and AS aliases are implemented; GROUP BY groups supported columns. Non-aggregate selected columns must belong to the grouping. GROUP BY requires an aggregate. For histogram instance totals, use SUM(instance_count), not COUNT(*).

```heapql
SELECT node_type, COUNT(*) AS object_rows, SUM(shallow_size) AS own_bytes
FROM instances
GROUP BY node_type
ORDER BY own_bytes DESC
```

Aggregates may use floating-point arithmetic. SUM(retained_size) can double-count ownership and should not be labeled live heap usage. LIMIT does not restrict aggregate input to the first N rows.

## JOIN

One INNER/JOIN or LEFT JOIN with an equality ON condition is implemented using hash join. Table aliases and qualified selected/filter columns are supported.

```heapql
SELECT *
FROM instances AS i
INNER JOIN class_histogram AS c ON i.class_name = c.class_name
WHERE i.retained_size > 1MB
LIMIT 20
```

This matches class metadata to instances, not an object-field graph traversal. Right/full/cross joins, arbitrary ON predicates, multiple chained joins, and general aggregate-over-join semantics are not promised. Qualify duplicate column names.

## Subqueries

Supported uncorrelated scalar comparisons and IN (SELECT ...) filters:

```heapql
SELECT object_id, class_name, retained_size
FROM instances
WHERE retained_size > (SELECT AVG(retained_size) FROM instances)
ORDER BY retained_size DESC
LIMIT 20
```

```heapql
SELECT object_id, class_name, retained_size
FROM instances
WHERE class_name IN (SELECT class_name FROM leak_suspects)
LIMIT 20
```

A scalar subquery must return exactly one row/column. IN selects a single output column. Correlated subqueries, arbitrary FROM subqueries, and a full SQL optimizer are not provided. Work/materialization can exceed the small final result.

## Object navigation

| Command | Result |
| --- | --- |
| :path 123456 | Bounded root path |
| :refs 123456 | Incoming referrers |
| :children 123456 | Immediate dominator children |
| :info 123456 | Object metadata/details |

IDs may be decimal or supported hexadecimal syntax. Use real IDs from this dump. Empty output can mean a leaf, not found, unsupported object type, or bounded search outcome.

## Pagination and unsupported syntax

Native execute_query optionally takes page and page_size; CLI uses --page/--rows. Pages are 1-based. Total matched/scanned counts differ from returned row count. Not all released UI hosts expose identical paging controls.

No INSERT/UPDATE/DELETE, persisted tables, general SQL functions, HAVING, UNION, DISTINCT, or general expression evaluator is promised. Read queries can still be expensive. QueryResult fields and precision limits are in [data structures](./data-structures.md).
