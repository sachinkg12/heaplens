//! Heap dump comparison: computes deltas between two analysis states.

use std::collections::HashMap;
use crate::indexed::types::HeapAnalysis;
use crate::{ClassHistogramEntry, LeakSuspect};

// Transport-only totals: no object graph, strings, fields or local file access.
macro_rules! totals {
    ($name:ident, $source:ty, {$($field:ident: $ty:ty),* $(,)?}) => {
        #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
        pub struct $name { $(pub $field: $ty),* }
        impl From<&$source> for $name {
            fn from(value: &$source) -> Self { Self { $($field: value.$field),* } }
        }
    };
}
totals!(SummaryTotals, crate::HeapSummary, {
    total_heap_size:u64, reachable_heap_size:u64, total_instances:u64,
    total_classes:u64, total_arrays:u64, total_gc_roots:u64
});
totals!(WasteTotals, crate::WasteAnalysis, {
    total_wasted_bytes:u64, waste_percentage:f64, duplicate_string_wasted_bytes:u64,
    empty_collection_wasted_bytes:u64, over_allocated_wasted_bytes:u64, boxed_primitive_wasted_bytes:u64
});

/// Compact immutable output of an analysis, usable across isolated editor processes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ComparisonSnapshot {
    pub summary: SummaryTotals,
    pub class_histogram: Vec<ClassHistogramEntry>,
    pub leak_suspects: Vec<LeakSuspect>,
    pub waste_analysis: WasteTotals,
}

pub fn compare_snapshots(baseline: &ComparisonSnapshot, current: &ComparisonSnapshot,
    baseline_label: &str, current_label: &str) -> HeapComparisonResult {
    compare_parts(&baseline.summary, &current.summary, &baseline.class_histogram,
        &current.class_histogram, &baseline.leak_suspects, &current.leak_suspects,
        &baseline.waste_analysis, &current.waste_analysis, baseline_label, current_label)
}

/// Bounded additive protocol; existing compare_heaps continues using the same calculation.
pub fn compare_snapshot_request(params: serde_json::Value) -> Result<HeapComparisonResult, String> {
    #[derive(serde::Deserialize)]
    struct Request { baseline: ComparisonSnapshot, current: ComparisonSnapshot,
        baseline_label: String, current_label: String }
    let request: Request = serde_json::from_value(params).map_err(|_| "Invalid comparison snapshots")?;
    for snapshot in [&request.baseline, &request.current] {
        if snapshot.class_histogram.len() > 200_000 || snapshot.leak_suspects.len() > 10_000 {
            return Err("Comparison snapshot exceeds row limit".into());
        }
        // i64 deltas cannot overflow when both unsigned operands fit i64.
        let value = serde_json::to_value(snapshot).map_err(|_| "Invalid snapshot")?;
        fn valid(value: &serde_json::Value) -> bool {
            match value {
                serde_json::Value::Number(n) => n.as_u64().map_or_else(
                    || n.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0 && v <= i64::MAX as f64),
                    |v| v <= i64::MAX as u64),
                serde_json::Value::String(s) => s.len() <= 16384,
                serde_json::Value::Array(a) => a.iter().all(valid),
                // Object addresses are identifiers, never operands in signed deltas.
                // Deserialization already guarantees u64; do not reject a valid
                // address merely because it exceeds the arithmetic range.
                serde_json::Value::Object(o) => o.iter().all(|(key, value)| key == "object_id" || valid(value)),
                _ => true,
            }
        }
        if !valid(&value) { return Err("Invalid comparison values".into()); }
    }
    if request.baseline_label.len() > 4096 || request.current_label.len() > 4096 {
        return Err("Comparison label too long".into());
    }
    Ok(compare_snapshots(&request.baseline, &request.current, &request.baseline_label, &request.current_label))
}

/// Summary delta between two heap dumps.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HeapSummaryDelta {
    pub baseline_total_heap_size: u64,
    pub current_total_heap_size: u64,
    pub total_heap_size_delta: i64,
    pub baseline_reachable_heap_size: u64,
    pub current_reachable_heap_size: u64,
    pub reachable_heap_size_delta: i64,
    pub baseline_total_instances: u64,
    pub current_total_instances: u64,
    pub total_instances_delta: i64,
    pub baseline_total_classes: u64,
    pub current_total_classes: u64,
    pub total_classes_delta: i64,
    pub baseline_total_arrays: u64,
    pub current_total_arrays: u64,
    pub total_arrays_delta: i64,
    pub baseline_total_gc_roots: u64,
    pub current_total_gc_roots: u64,
    pub total_gc_roots_delta: i64,
}

/// Per-class delta between two heap dumps.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ClassHistogramDelta {
    pub class_name: String,
    pub instance_count_delta: i64,
    pub shallow_size_delta: i64,
    pub retained_size_delta: i64,
    pub baseline_instance_count: u64,
    pub baseline_shallow_size: u64,
    pub baseline_retained_size: u64,
    pub current_instance_count: u64,
    pub current_shallow_size: u64,
    pub current_retained_size: u64,
    /// One of: "grew", "shrank", "new", "removed", "unchanged"
    pub change_type: String,
}

/// Change in a leak suspect between two heap dumps.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LeakSuspectChange {
    pub class_name: String,
    /// One of: "new", "resolved", "persisted"
    pub change_type: String,
    pub current_retained_size: u64,
    pub current_retained_percentage: f64,
    pub baseline_retained_size: u64,
    pub baseline_retained_percentage: f64,
    pub retained_size_delta: i64,
    pub retained_percentage_delta: f64,
    pub description: String,
}

/// Waste delta between two heap dumps.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WasteDelta {
    pub baseline_total_wasted_bytes: u64,
    pub current_total_wasted_bytes: u64,
    pub total_wasted_delta: i64,
    pub baseline_waste_percentage: f64,
    pub current_waste_percentage: f64,
    pub waste_percentage_delta: f64,
    pub duplicate_string_wasted_delta: i64,
    pub empty_collection_wasted_delta: i64,
    pub over_allocated_wasted_delta: i64,
    pub boxed_primitive_wasted_delta: i64,
}

/// Full comparison result between a baseline and current heap dump.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HeapComparisonResult {
    pub baseline_path: String,
    pub current_path: String,
    pub summary_delta: HeapSummaryDelta,
    pub histogram_delta: Vec<ClassHistogramDelta>,
    pub leak_suspect_changes: Vec<LeakSuspectChange>,
    pub waste_delta: WasteDelta,
}

/// Compares two heap analysis states and returns a detailed delta.
pub fn compare_heaps(
    baseline: &dyn HeapAnalysis,
    current: &dyn HeapAnalysis,
    baseline_path: &str,
    current_path: &str,
) -> HeapComparisonResult {
    compare_parts(&SummaryTotals::from(baseline.get_summary()), &SummaryTotals::from(current.get_summary()),
        baseline.get_class_histogram(), current.get_class_histogram(), baseline.get_leak_suspects(),
        current.get_leak_suspects(), &WasteTotals::from(baseline.get_waste_analysis()),
        &WasteTotals::from(current.get_waste_analysis()), baseline_path, current_path)
}

fn compare_parts(bs: &SummaryTotals, cs: &SummaryTotals,
    baseline_histogram: &[ClassHistogramEntry], current_histogram: &[ClassHistogramEntry],
    baseline_leak_suspects: &[LeakSuspect], current_leak_suspects: &[LeakSuspect],
    bw: &WasteTotals, cw: &WasteTotals, baseline_path: &str, current_path: &str) -> HeapComparisonResult {

    // Summary delta
    let summary_delta = HeapSummaryDelta {
        baseline_total_heap_size: bs.total_heap_size,
        current_total_heap_size: cs.total_heap_size,
        total_heap_size_delta: cs.total_heap_size as i64 - bs.total_heap_size as i64,
        baseline_reachable_heap_size: bs.reachable_heap_size,
        current_reachable_heap_size: cs.reachable_heap_size,
        reachable_heap_size_delta: cs.reachable_heap_size as i64 - bs.reachable_heap_size as i64,
        baseline_total_instances: bs.total_instances,
        current_total_instances: cs.total_instances,
        total_instances_delta: cs.total_instances as i64 - bs.total_instances as i64,
        baseline_total_classes: bs.total_classes,
        current_total_classes: cs.total_classes,
        total_classes_delta: cs.total_classes as i64 - bs.total_classes as i64,
        baseline_total_arrays: bs.total_arrays,
        current_total_arrays: cs.total_arrays,
        total_arrays_delta: cs.total_arrays as i64 - bs.total_arrays as i64,
        baseline_total_gc_roots: bs.total_gc_roots,
        current_total_gc_roots: cs.total_gc_roots,
        total_gc_roots_delta: cs.total_gc_roots as i64 - bs.total_gc_roots as i64,
    };

    // Histogram delta
    let baseline_hist: HashMap<&str, &ClassHistogramEntry> = baseline_histogram
        .iter()
        .map(|e| (e.class_name.as_str(), e))
        .collect();
    let current_hist: HashMap<&str, &ClassHistogramEntry> = current_histogram
        .iter()
        .map(|e| (e.class_name.as_str(), e))
        .collect();

    let mut histogram_delta: Vec<ClassHistogramDelta> = Vec::new();

    for ce in current_histogram {
        if let Some(be) = baseline_hist.get(ce.class_name.as_str()) {
            let inst_delta = ce.instance_count as i64 - be.instance_count as i64;
            let shallow_delta = ce.shallow_size as i64 - be.shallow_size as i64;
            let retained_delta = ce.retained_size as i64 - be.retained_size as i64;
            let change_type = if retained_delta > 0 {
                "grew"
            } else if retained_delta < 0 {
                "shrank"
            } else {
                "unchanged"
            };
            histogram_delta.push(ClassHistogramDelta {
                class_name: ce.class_name.clone(),
                instance_count_delta: inst_delta,
                shallow_size_delta: shallow_delta,
                retained_size_delta: retained_delta,
                baseline_instance_count: be.instance_count,
                baseline_shallow_size: be.shallow_size,
                baseline_retained_size: be.retained_size,
                current_instance_count: ce.instance_count,
                current_shallow_size: ce.shallow_size,
                current_retained_size: ce.retained_size,
                change_type: change_type.to_string(),
            });
        } else {
            histogram_delta.push(ClassHistogramDelta {
                class_name: ce.class_name.clone(),
                instance_count_delta: ce.instance_count as i64,
                shallow_size_delta: ce.shallow_size as i64,
                retained_size_delta: ce.retained_size as i64,
                baseline_instance_count: 0,
                baseline_shallow_size: 0,
                baseline_retained_size: 0,
                current_instance_count: ce.instance_count,
                current_shallow_size: ce.shallow_size,
                current_retained_size: ce.retained_size,
                change_type: "new".to_string(),
            });
        }
    }

    for be in baseline_histogram {
        if !current_hist.contains_key(be.class_name.as_str()) {
            histogram_delta.push(ClassHistogramDelta {
                class_name: be.class_name.clone(),
                instance_count_delta: -(be.instance_count as i64),
                shallow_size_delta: -(be.shallow_size as i64),
                retained_size_delta: -(be.retained_size as i64),
                baseline_instance_count: be.instance_count,
                baseline_shallow_size: be.shallow_size,
                baseline_retained_size: be.retained_size,
                current_instance_count: 0,
                current_shallow_size: 0,
                current_retained_size: 0,
                change_type: "removed".to_string(),
            });
        }
    }

    histogram_delta.sort_by(|a, b| {
        b.retained_size_delta
            .abs()
            .cmp(&a.retained_size_delta.abs())
    });

    // Leak suspect changes
    let baseline_suspects: HashMap<&str, &LeakSuspect> = baseline_leak_suspects
        .iter()
        .map(|s| (s.class_name.as_str(), s))
        .collect();
    let current_suspects: HashMap<&str, &LeakSuspect> = current_leak_suspects
        .iter()
        .map(|s| (s.class_name.as_str(), s))
        .collect();

    let mut leak_suspect_changes: Vec<LeakSuspectChange> = Vec::new();

    for cs_entry in current_leak_suspects {
        if let Some(bs_entry) = baseline_suspects.get(cs_entry.class_name.as_str()) {
            leak_suspect_changes.push(LeakSuspectChange {
                class_name: cs_entry.class_name.clone(),
                change_type: "persisted".to_string(),
                current_retained_size: cs_entry.retained_size,
                current_retained_percentage: cs_entry.retained_percentage,
                baseline_retained_size: bs_entry.retained_size,
                baseline_retained_percentage: bs_entry.retained_percentage,
                retained_size_delta: cs_entry.retained_size as i64 - bs_entry.retained_size as i64,
                retained_percentage_delta: cs_entry.retained_percentage
                    - bs_entry.retained_percentage,
                description: cs_entry.description.clone(),
            });
        } else {
            leak_suspect_changes.push(LeakSuspectChange {
                class_name: cs_entry.class_name.clone(),
                change_type: "new".to_string(),
                current_retained_size: cs_entry.retained_size,
                current_retained_percentage: cs_entry.retained_percentage,
                baseline_retained_size: 0,
                baseline_retained_percentage: 0.0,
                retained_size_delta: cs_entry.retained_size as i64,
                retained_percentage_delta: cs_entry.retained_percentage,
                description: cs_entry.description.clone(),
            });
        }
    }

    for bs_entry in baseline_leak_suspects {
        if !current_suspects.contains_key(bs_entry.class_name.as_str()) {
            leak_suspect_changes.push(LeakSuspectChange {
                class_name: bs_entry.class_name.clone(),
                change_type: "resolved".to_string(),
                current_retained_size: 0,
                current_retained_percentage: 0.0,
                baseline_retained_size: bs_entry.retained_size,
                baseline_retained_percentage: bs_entry.retained_percentage,
                retained_size_delta: -(bs_entry.retained_size as i64),
                retained_percentage_delta: -bs_entry.retained_percentage,
                description: format!("Previously: {}", bs_entry.description),
            });
        }
    }

    // Waste delta
    let waste_delta = WasteDelta {
        baseline_total_wasted_bytes: bw.total_wasted_bytes,
        current_total_wasted_bytes: cw.total_wasted_bytes,
        total_wasted_delta: cw.total_wasted_bytes as i64 - bw.total_wasted_bytes as i64,
        baseline_waste_percentage: bw.waste_percentage,
        current_waste_percentage: cw.waste_percentage,
        waste_percentage_delta: cw.waste_percentage - bw.waste_percentage,
        duplicate_string_wasted_delta: cw.duplicate_string_wasted_bytes as i64
            - bw.duplicate_string_wasted_bytes as i64,
        empty_collection_wasted_delta: cw.empty_collection_wasted_bytes as i64
            - bw.empty_collection_wasted_bytes as i64,
        over_allocated_wasted_delta: cw.over_allocated_wasted_bytes as i64
            - bw.over_allocated_wasted_bytes as i64,
        boxed_primitive_wasted_delta: cw.boxed_primitive_wasted_bytes as i64
            - bw.boxed_primitive_wasted_bytes as i64,
    };

    HeapComparisonResult {
        baseline_path: baseline_path.to_string(),
        current_path: current_path.to_string(),
        summary_delta,
        histogram_delta,
        leak_suspect_changes,
        waste_delta,
    }
}
