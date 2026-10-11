---
sidebar_position: 3
title: Nine MCP tools
---

These are current tool definitions from `hprof-server --mcp`. Use tools/list to inspect the exact native version. Arguments are objects; paths belong to the **server machine**. Analyze first, except for lifecycle/tool discovery.

| Tool | Required arguments | Optional | Result / prerequisite |
| --- | --- | --- | --- |
| analyze_heap | path | — | Synchronous analysis text summary; establishes cached state |
| get_leak_suspects | path | — | Candidate descriptions from cached analysis, not confirmed leaks |
| get_class_histogram | path | limit (default 30) | Bounded top rows; shallow/retained aggregates |
| drill_down | path, object_id | — | Immediate dominator children; not every direct field reference |
| get_summary | path | — | Modeled heap sizes and counts |
| get_waste_analysis | path | — | Formatted estimates; four-category backend data, formatter may show a subset |
| execute_heapql | path, query | — | Read-only query table / navigation output |
| inspect_object | path, object_id | — | Field names/types, primitive values, reference summaries for supported instances |
| compare_heaps | current_path, baseline_path | — | Deltas; both files must already be analyzed in this process |

Object IDs are unsigned native identifiers scoped to one dump. Use a precision-preserving client when they exceed JavaScript's safe integer range. Do not silently round IDs.

## Example tool requests

```json
{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"execute_heapql","arguments":{"path":"/absolute/path/app.hprof","query":"SELECT object_id, class_name, retained_size FROM instances ORDER BY retained_size DESC LIMIT 20"}}}
```

```json
{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"inspect_object","arguments":{"path":"/absolute/path/app.hprof","object_id":123456}}}
```

Use an ID actually returned for your dump, not this illustrative number. See [HeapQL](../api-reference/heapql.md) for joins/subqueries/navigation.

## Response shape

MCP tools return content blocks, typically formatted text:

```json
{"content":[{"type":"text","text":"Illustrative formatted tool output"}],"isError":false}
```

This is not the editor's raw ObjectReport/summary JSON contract. Missing arguments, unanalyzed paths, unsupported IDs, and query errors can return isError true. An empty child list may mean a leaf/unknown ID; inspection can fail for non-instance nodes. Do not turn an empty output into a correctness guarantee.

Top-N lists/previews are incomplete. LIMIT/limit does not bound initial analysis RAM or necessarily query scans. The native process can retain multiple graphs; stop it when finished.

## Privacy and interpretation

MCP tool values/previews are **not minimized editor prompts**. Client/model policies apply to returned data. Names, paths, and primitive contents can be exposed. Read [privacy](../ai-integration/privacy.md).

Retained class totals overlap across classes; a resolved suspect is not proof a repair worked. See [size semantics](../concepts/retained-vs-shallow-size.md) and [Compare](../tabs-guide/compare-tab.md).
