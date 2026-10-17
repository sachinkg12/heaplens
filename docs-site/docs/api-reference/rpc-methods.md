---
sidebar_position: 1
title: Native JSON-RPC methods
---

Start `hprof-server` in its default mode, not --mcp. Messages are newline-delimited JSON on stdin/stdout; stderr is local diagnostics. This is a local trusted-process protocol, not an authenticated public service.

## analyze_heap

```json
{"jsonrpc":"2.0","id":1,"method":"analyze_heap","params":{"path":"/absolute/path/app.hprof"}}
```

Returns a processing acknowledgement with request_id, then asynchronous heap_analysis_complete notification. Progress/summary notifications can arrive before completion. Route by current process/session and request identity; acknowledgement is not success.

A completed payload includes status, summary, top_objects, top_layers, class_histogram, leak_suspects, object_leak_suspects where available, optional storage metadata, and waste_analysis. Indexed Waste is normally null until explicitly requested. Error/cancellation fields differ; do not assume completion always carries data. See [types](./data-structures.md).

### Progressive full-analysis results

`heap_analysis_progress` carries the current `request_id` and `stage`. Not every event has numeric `phase` or `total_phases`; use the stage label rather than inventing a percentage.

- A `sizing` snapshot with `kind: records` contains partial instance/array/class/root record counts and `complete: false`. It does not establish heap sizes or reachability.
- A `shallow_ready` snapshot with `kind: shallow` contains a shallow summary, class histogram and readiness labels. Reachable heap is null and histogram entries omit retained sizes. Full analysis continues automatically; do not launch another job.
- Stages such as `index_verifying`, `edges`, `index_publishing` and `dominators` describe ongoing work. Only a successful completion establishes full retained results.

Route every event by active process/session and request identity. Cancellation or failure does not promote the last shallow snapshot to a completed full analysis.

## scan_heap

```json
{"jsonrpc":"2.0","id":8,"method":"scan_heap","params":{"path":"/absolute/path/app.hprof"}}
```

Returns a processing acknowledgement with `request_id` and `analysis_scope: shallow`, then `heap_scan_progress` and `heap_scan_complete` notifications. A successful completion contains `analysis_scope: shallow`, `counts_scope: allocation_records_and_declared_class_ids`, a shallow summary/class histogram and readiness labels. The summary uses `declared_classes`, not full-analysis `total_classes`.

The scan supports conventional HPROF 1.0.1 and 1.0.2. It never installs a graph or silently starts retained analysis. Counts describe allocation records, not validated unique object IDs. After scanning, graph-dependent requests return error `-32002` until a separate explicit `analyze_heap` succeeds. Starting a scan replaces any older cached full state for that path. Overlapping analysis is rejected with `-32001`; cancel and await completion before starting another request.

## get_waste_analysis

```json
{"jsonrpc":"2.0","id":9,"method":"get_waste_analysis","params":{"path":"/absolute/path/app.hprof"}}
```

Requires completed full analysis. Explicitly calculates Waste on first request and returns a `WasteAnalysis` object; later requests reuse that analysis's result. Ordinary queries, object inspection and tab navigation do not trigger it. Keep the original capture unchanged for deferred content reads. Quick Scan does not enable this method.

## cancel_analysis and ping

Cancellation takes path and optionally analysis_request_id for the active analysis. It requests cooperative cancellation, not immediate safe deletion of a graph. Await outcome before retrying. Ping returns status ok; a missing heartbeat alone is not proof a live long analysis should be killed.

```json
{"jsonrpc":"2.0","id":2,"method":"ping"}
```

## get_children

```json
{"jsonrpc":"2.0","id":3,"method":"get_children","params":{"path":"/absolute/path/app.hprof","object_id":123456}}
```

Requires cached analysis. Result is an **ObjectReport array**, not a wrapper object. Empty can mean leaf/unknown ID. Children are immediate dominators, not necessarily direct fields.

## get_referrers and gc_root_path

Both take path and object_id. Referrers are incoming ObjectReport entries. gc_root_path returns an ordered root-to-target path bounded to 100 nodes; empty/truncated does not prove collectability or enumerate all routes.

```json
{"jsonrpc":"2.0","id":4,"method":"gc_root_path","params":{"path":"/absolute/path/app.hprof","object_id":123456}}
```

## inspect_object

Takes path and object_id, returns supported field data or null. Absent optional field values are omitted; ref_summary is structured.

Illustrative result, not fixture measurements:

```json
{"jsonrpc":"2.0","id":5,"result":[{"name":"size","field_type":"int","primitive_value":"16"},{"name":"table","field_type":"reference","ref_object_id":234567,"ref_summary":{"class_name":"java.lang.Object[]","node_type":"Array","shallow_size":152,"retained_size":152}}]}
```

Use an ID actually returned for the dump. Fields/previews can be sensitive.

## execute_query

```json
{"jsonrpc":"2.0","id":6,"method":"execute_query","params":{"path":"/absolute/path/app.hprof","query":"SELECT object_id, class_name, retained_size FROM instances ORDER BY retained_size DESC LIMIT 20","page":1,"page_size":20}}
```

Without page it executes an unpaged query; with page it uses 1-based pagination (default page_size 500). Returns QueryResult. Query failures return an error with code -32000 and a message. FROM objects is invalid; see [HeapQL](./heapql.md).

## export_json

Takes path and output_path; returns success true after writing. Native export contains source_file, summary, class_histogram, leak_suspects, object_leak_suspects, and top_objects. It is not the CLI report schema or automatically the full waste output.

**Native export can overwrite an existing output path**; use a safe new destination. The standalone CLI's no-overwrite rule is separate. Exports contain names/paths and are local, not auto-uploaded.

## compare_heaps

```json
{"jsonrpc":"2.0","id":7,"method":"compare_heaps","params":{"current_path":"/absolute/path/current.hprof","baseline_path":"/absolute/path/baseline.hprof"}}
```

Both must be fully analyzed in this server. Returns baseline_path, current_path, summary_delta, histogram_delta, a flat leak_suspect_changes array, and waste_delta. Waste delta is null unless both analyses have calculated Waste; comparison does not request it implicitly. Deltas are current minus baseline. See [types](./data-structures.md).

## list_analyzed_files

No params required; returns an object with files containing cached path strings. This is current process state, not a persistent library.

## get_dominator_subtree

Takes path, optional object_id (default 0), max_depth (default 6), and max_children (default 20); returns bounded nested subtree data for flame/icicle rendering. Bounds affect presentation, not initial analysis RAM.

## get_timeline_data

Takes paths and optional top_n (default 10). Returns snapshots sorted by file modification timestamp; mtime need not be true capture time. Requires relevant states already loaded.

## compare_snapshots

Adapter-oriented bounded comparison accepts baseline/current compact snapshots and labels. Each snapshot contains summary totals, class_histogram, leak_suspects, and optional waste_analysis totals. If either Waste result is unavailable, waste_delta is null, not zero. It does not need both full graphs resident. Row/string/numeric bounds are validated; labels/paths remain sensitive.

## Failures and lifetime

Unknown methods return -32601. Other handler failures and transport exits may be surfaced as local stderr/request failures or timeouts, not uniformly shaped errors. Do not assume every malformed request gets a prompt standard error response. State is process-local, dump IDs are native u64, and precision-preserving clients are needed for large IDs. Stop owned processes when done. Retry is a **host lifecycle action**, not a native RPC method.
