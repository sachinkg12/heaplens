//! Explicit output projections: raw heap string/field contents never enter reports.
use super::Failure;
use hprof_analyzer::{
    comparison::{ComparisonSnapshot, HeapComparisonResult},
    indexed::HeapAnalysis,
};
use serde_json::{json, Value};

pub const WARNINGS: [&str; 3] = [
    "Retained memory is evidence for investigation, not proof of a leak.",
    "Class retained sets can overlap across classes; their sizes are not additive.",
    "Output limits do not bound parsing, graph or query-evaluation memory; no disk indexes are reused.",
];

pub fn analyze(state: &dyn HeapAnalysis, rows: usize) -> Value {
    let mut histogram = state.get_class_histogram().to_vec();
    histogram.sort_by(|a, b| {
        b.retained_size
            .cmp(&a.retained_size)
            .then(a.class_name.cmp(&b.class_name))
    });
    let hist_total = histogram.len();
    histogram.truncate(rows);
    let mut objects = state.get_top_layers(3, 50);
    objects.sort_by(|a, b| {
        b.retained_size
            .cmp(&a.retained_size)
            .then(a.object_id.cmp(&b.object_id))
    });
    let obj_total = objects.len();
    objects.truncate(rows);
    let mut suspects = state.get_leak_suspects().to_vec();
    let mut object_suspects = state.get_object_leak_suspects().to_vec();
    let order = |a: &hprof_analyzer::LeakSuspect, b: &hprof_analyzer::LeakSuspect| {
        b.retained_size
            .cmp(&a.retained_size)
            .then(a.class_name.cmp(&b.class_name))
            .then(a.object_id.cmp(&b.object_id))
    };
    suspects.sort_by(order);
    object_suspects.sort_by(order);
    let suspect_total = suspects.len();
    let object_suspect_total = object_suspects.len();
    suspects.truncate(rows);
    object_suspects.truncate(rows);
    json!({
        "summary": state.get_summary(), "class_histogram": histogram,
        "top_objects": objects, "leak_suspects": suspects, "object_leak_suspects": object_suspects,
        "waste_totals": hprof_analyzer::comparison::WasteTotals::from(state.get_waste_analysis()),
        "selection": {"rows_per_section": rows, "class_histogram_total": hist_total,
            "leak_suspects_total": suspect_total, "object_leak_suspects_total": object_suspect_total,
            "top_objects_available": obj_total, "top_objects_scope": "Depth-3 dominator traversal, at most 50 candidates"},
        "truncated": hist_total > rows || suspect_total > rows || object_suspect_total > rows || obj_total > rows
    })
}

pub fn snapshot(state: &dyn HeapAnalysis) -> Result<ComparisonSnapshot, Failure> {
    let snapshot = ComparisonSnapshot {
        summary: state.get_summary().into(),
        class_histogram: state.get_class_histogram().to_vec(),
        leak_suspects: state.get_leak_suspects().to_vec(),
        waste_analysis: state.get_waste_analysis().into(),
    };
    // The shared comparator represents deltas as i64. Validate operands, not
    // object IDs (which can validly use the whole u64 range).
    fn safe(value: &Value, key: &str) -> bool {
        if key == "object_id" {
            return true;
        }
        match value {
            Value::Number(n) => n.as_u64().map_or_else(
                || {
                    n.as_f64()
                        .is_some_and(|v| v.is_finite() && v >= 0.0 && v < i64::MAX as f64)
                },
                |v| v <= i64::MAX as u64,
            ),
            Value::Object(o) => o.iter().all(|(k, v)| safe(v, k)),
            Value::Array(a) => a.iter().all(|v| safe(v, "")),
            _ => true,
        }
    }
    if !safe(
        &serde_json::to_value(&snapshot).map_err(|_| Failure::analysis())?,
        "",
    ) {
        return Err(Failure::new(
            4,
            "comparison_range",
            "Comparison values exceed the supported signed delta range.",
        ));
    }
    Ok(snapshot)
}

pub fn compare(
    mut result: HeapComparisonResult,
    baseline_summary: Value,
    current_summary: Value,
    rows: usize,
) -> Value {
    result.histogram_delta.sort_by(|a, b| {
        b.retained_size_delta
            .unsigned_abs()
            .cmp(&a.retained_size_delta.unsigned_abs())
            .then(a.class_name.cmp(&b.class_name))
    });
    result.leak_suspect_changes.sort_by(|a, b| {
        b.retained_size_delta
            .unsigned_abs()
            .cmp(&a.retained_size_delta.unsigned_abs())
            .then(a.class_name.cmp(&b.class_name))
    });
    let hist_total = result.histogram_delta.len();
    let suspects_total = result.leak_suspect_changes.len();
    result.histogram_delta.truncate(rows);
    result.leak_suspect_changes.truncate(rows);
    json!({"comparison": result, "baseline_summary": baseline_summary, "current_summary": current_summary,
        "size_models_differ": baseline_summary["size_model"] != current_summary["size_model"],
        "selection": {"rows_per_section": rows,"histogram_delta_total":hist_total,"leak_suspect_changes_total":suspects_total},
        "truncated":hist_total > rows || suspects_total > rows})
}

// IDs are strings in the versioned CLI schema, including arbitrary query aliases.
// All integer query cells use strings: column names are not sufficient to infer
// whether an aliased/aggregated value is an object ID. Byte counts elsewhere are JSON integers.
pub fn lossless_ids(value: &mut Value) {
    match value {
        Value::Object(o) => {
            if let Some(id) = o.get_mut("object_id") {
                if let Some(n) = id.as_u64() {
                    *id = Value::String(n.to_string());
                }
            }
            for v in o.values_mut() {
                lossless_ids(v);
            }
        }
        Value::Array(a) => {
            for v in a {
                lossless_ids(v);
            }
        }
        _ => {}
    }
}

pub fn query_cells(value: &mut Value) {
    if let Some(rows) = value["result"]["rows"].as_array_mut() {
        for row in rows {
            if let Some(cells) = row.as_array_mut() {
                for cell in cells {
                    if let Some(n) = cell.as_u64() {
                        *cell = Value::String(n.to_string());
                    } else if let Some(n) = cell.as_i64() {
                        *cell = Value::String(n.to_string());
                    }
                }
            }
        }
    }
}

pub fn text(value: &Value) -> String {
    // Pretty JSON data inside a text report preserves exact units and escapes
    // terminal controls in heap-derived names. No raw query/path is echoed.
    format!("HeapLens {} ({})\nSizes: bytes; see summary.size_model for estimation provenance.\n{}\nWarnings:\n{}\n",
        value["command"].as_str().unwrap_or("report"), value["backend"].as_str().unwrap_or("unknown"),
        serde_json::to_string_pretty(&value["data"]).unwrap_or_default(),
        value["warnings"].as_array().unwrap().iter().map(|s| format!("- {}", s.as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_omit_raw_contents_and_limit_rows() {
        let mut s = hprof_analyzer::test_helpers::build_test_state();
        s.waste_analysis
            .duplicate_strings
            .push(hprof_analyzer::waste::DuplicateStringGroup {
                preview: "PRIVATE_STRING_MARKER".into(),
                count: 2,
                wasted_bytes: 12,
                total_bytes: 24,
            });
        let report = analyze(&s, 1);
        assert!(!report.to_string().contains("PRIVATE_STRING_MARKER"));
        assert_eq!(report["class_histogram"].as_array().unwrap().len(), 1);
        assert_eq!(report["truncated"], true);
    }
    #[test]
    fn ids_and_aliased_query_integers_are_lossless() {
        let mut value =
            json!({"object_id":u64::MAX,"result":{"rows":[[9007199254740993u64, -12, 1.5]]}});
        lossless_ids(&mut value);
        query_cells(&mut value);
        assert_eq!(value["object_id"], u64::MAX.to_string());
        assert_eq!(
            value["result"]["rows"][0],
            json!(["9007199254740993", "-12", 1.5])
        );
    }
    #[test]
    fn comparison_checks_deltas_but_not_ids() {
        let mut s = hprof_analyzer::test_helpers::build_test_state();
        s.leak_suspects[0].object_id = u64::MAX;
        assert!(snapshot(&s).is_ok());
        s.summary.total_heap_size = u64::MAX;
        assert!(snapshot(&s).is_err());
    }
}
