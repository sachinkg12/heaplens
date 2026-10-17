---
sidebar_position: 2
title: Native data structures
---

These shapes describe current native JSON-RPC serialization, not MCP formatted text or the standalone CLI's versioned envelope. Optional fields can be **omitted**, not always null. Bytes are integers unless stated otherwise.

## ObjectReport and fields

```typescript
interface ObjectReport {
  object_id: number; // native u64, opaque dump ID
  node_type: string;
  class_name: string;
  shallow_size: number;
  retained_size: number;
  field_name?: string;
}
interface RefSummary {
  class_name: string;
  node_type: string;
  shallow_size: number;
  retained_size: number;
}
interface FieldInfo {
  name: string;
  field_type: string;
  primitive_value?: string;
  ref_object_id?: number;
  ref_summary?: RefSummary;
}
```

Inspect results can be an array or null when no supported instance data is available. Reference summary is a **structured object**, not a display string. Synthetic Root/SuperRoot/Class records can use ID 0; they are not normal source objects. ObjectReport lists are bounded selections, not all objects.

## HeapSummary

```typescript
interface HeapSummary {
  total_heap_size: number;
  reachable_heap_size: number;
  total_instances: number;
  total_classes: number;
  total_arrays: number;
  total_gc_roots: number;
  hprof_version: string;
  heap_types: string[];
  size_model?: {
    name: string;
    estimated: boolean;
    layout: {
      word_bytes: number;
      reference_bytes: number;
      class_pointer_bytes: number;
      alignment: number;
    };
    layout_source: string;
    incomplete_classes: number;
    retained_size_policy?: string;
    instance_layout_policy?: string;
    producer_detection?: string;
  };
}
```

Total/reachable refer to modeled heap bytes, not file bytes/RSS. hprof_version is a format string, not a JDK release. Size metadata may be absent for older/synthetic states.

## Shallow results and readiness

Full-analysis intermediate snapshots and completed Quick Scan results are not `HeapSummary` with a guessed reachable value. An intermediate `snapshot.kind: shallow` uses the full summary's class counter but sets `reachable_heap_size` to null. Quick Scan has its own shape:

```typescript
interface ShallowSummary {
  total_heap_size: number;
  reachable_heap_size: null;
  total_instances: number;
  total_arrays: number;
  declared_classes: number;
  total_gc_roots: number;
  unresolved_class_names: number;
  hprof_version: string;
  heap_types: string[];
  size_model: NonNullable<HeapSummary['size_model']>;
}
interface ShallowClassEntry {
  class_name: string;
  instance_count: number;
  shallow_size: number;
}
```

Quick Scan identifies `analysis_scope: shallow` and `counts_scope: allocation_records_and_declared_class_ids`. Its readiness marks summary/shallow_histogram ready and reachability/retained/references/waste not calculated. An intermediate full-analysis snapshot has a separate readiness object and does not end the running job. Neither histogram shape has a retained field until full analysis completes. Missing values must not be converted into zero or used to enable graph actions.

## Storage metadata

Indexed full-analysis completion can include this optional storage report; it is not a field inside `HeapSummary`:

```typescript
interface StorageReport {
  mode: 'memory' | 'disk';
  cache_status: 'disabled' | 'built' | 'reused';
  edge_buffer_bytes: number;
}
```

Memory reports `disabled` and a zero edge buffer. Disk reports `built` or `reused` with the configured scratch buffer. These values describe structural storage, not a hard process-memory limit or saved dominator results.

## Histogram and suspects

```typescript
interface ClassHistogramEntry {
  class_name: string;
  instance_count: number;
  shallow_size: number;
  retained_size: number;
}
interface LeakSuspect {
  class_name: string;
  object_id: number;
  retained_size: number;
  retained_percentage: number;
  description: string;
  accumulation_point?: string;
}
```

Histogram retained counts non-overlapping within-class subtrees, not a simple sum. Cross-class retained totals overlap. Candidate percentages are heuristics, not probabilities. Host-enriched dependency information is not a guaranteed native LeakSuspect field.

## WasteAnalysis

```typescript
interface WasteAnalysis {
  total_wasted_bytes: number;
  waste_percentage: number;
  duplicate_string_wasted_bytes: number;
  empty_collection_wasted_bytes: number;
  over_allocated_wasted_bytes: number;
  boxed_primitive_wasted_bytes: number;
  duplicate_strings: {preview: string; count: number; wasted_bytes: number; total_bytes: number}[];
  empty_collections: {class_name: string; count: number; wasted_bytes: number}[];
  over_allocated_collections: {class_name: string; count: number; wasted_bytes: number; avg_fill_ratio: number}[];
  boxed_primitives: {class_name: string; count: number; wasted_bytes: number; unboxed_size: number}[];
}
```

Duplicate groups are bounded; preview length is truncated to 120 characters by the backend. All categories are estimates; waste_percentage uses total modeled heap. See [limits](../concepts/waste-analysis.md).

Indexed full-analysis completion normally contains `waste_analysis: null`. The explicit `get_waste_analysis` RPC returns the object and caches it for that native analysis. In CLI Analyze data, `waste_status` distinguishes `ready` from `not_calculated`, and `waste_totals` is null when unavailable. An unavailable result is not zero waste.

## QueryResult

```typescript
interface QueryResult {
  columns: string[];
  rows: unknown[][];
  total_scanned: number;
  total_matched: number;
  execution_time_ms: number;
  page?: number;
  total_pages?: number;
  total_rows?: number;
}
```

Native IDs/counts/bytes are u64 JSON numbers. JavaScript Number loses integer precision beyond 2^53−1; use precision-preserving parsing rather than rounding identifiers. Native JSON-RPC uses numeric IDs; CLI query integer-cell encoding uses a separate decimal-string envelope.

## Comparison

The native result has baseline_path, current_path, summary_delta, **histogram_delta**, a flat **leak_suspect_changes array**, and waste_delta. Histogram rows contain baseline/current instance/shallow/retained values, signed deltas, and change_type (grew/shrank/new/removed/unchanged). Suspect changes contain class_name, current/baseline retention/percentage, signed deltas, description, and change_type (new/resolved/persisted). Waste deltas include all four categories when both inputs have calculated results; otherwise waste_delta is null. Terminal `compare` explicitly calculates both, whereas interactive comparison uses already available snapshot results.

Signed deltas are current minus baseline; paths/labels can be sensitive. Resolved does not establish a verified repair. See [RPC](./rpc-methods.md) and [Compare](../tabs-guide/compare-tab.md).
