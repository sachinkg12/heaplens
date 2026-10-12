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
  };
}
```

Total/reachable refer to modeled heap bytes, not file bytes/RSS. hprof_version is a format string, not a JDK release. Size metadata may be absent for older/synthetic states.

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

The native result has baseline_path, current_path, summary_delta, **histogram_delta**, a flat **leak_suspect_changes array**, and waste_delta. Histogram rows contain baseline/current instance/shallow/retained values, signed deltas, and change_type (grew/shrank/new/removed/unchanged). Suspect changes contain class_name, current/baseline retention/percentage, signed deltas, description, and change_type (new/resolved/persisted). Waste deltas include all four categories.

Signed deltas are current minus baseline; paths/labels can be sensitive. Resolved does not establish a verified repair. See [RPC](./rpc-methods.md) and [Compare](../tabs-guide/compare-tab.md).
