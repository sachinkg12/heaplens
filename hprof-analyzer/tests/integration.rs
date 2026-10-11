//! Integration tests for HeapQL features: JOIN, subqueries, pagination, compare_heaps.
//! Uses synthetic AnalysisState instances (no real .hprof files needed).

use hprof_analyzer::test_helpers::{build_test_state, build_second_test_state};
use hprof_analyzer::compare_heaps;
use serde_json;

fn comparison_snapshot(state: &dyn hprof_analyzer::indexed::types::HeapAnalysis) -> hprof_analyzer::comparison::ComparisonSnapshot {
    hprof_analyzer::comparison::ComparisonSnapshot {
        summary: state.get_summary().into(), class_histogram: state.get_class_histogram().to_vec(),
        leak_suspects: state.get_leak_suspects().to_vec(), waste_analysis: state.get_waste_analysis().into(),
    }
}

#[test]
fn compact_snapshots_match_existing_comparison_in_both_directions() {
    let a=build_test_state();let b=build_second_test_state();
    for (before,after) in [(&a,&b),(&b,&a),(&a,&a)] {
        let existing=compare_heaps(before,after,"before","after");
        let compact=hprof_analyzer::comparison::compare_snapshots(&comparison_snapshot(before),&comparison_snapshot(after),"before","after");
        fn normalized(value: impl serde::Serialize)->serde_json::Value {
            let mut v=serde_json::to_value(value).unwrap();
            for key in ["histogram_delta","leak_suspect_changes"] {
                v[key].as_array_mut().unwrap().sort_by_key(|row|row["class_name"].as_str().unwrap().to_string());
            } v
        }
        assert_eq!(normalized(existing),normalized(compact));
    }
}

#[test]
fn snapshot_protocol_roundtrip_keeps_signed_deltas_and_rejects_bad_numbers() {
    let params=serde_json::json!({"baseline":comparison_snapshot(&build_second_test_state()),
        "current":comparison_snapshot(&build_test_state()),"baseline_label":"before","current_label":"after"});
    let result=hprof_analyzer::comparison::compare_snapshot_request(params.clone()).unwrap();
    assert_eq!(result.summary_delta.total_heap_size_delta,-8192);
    let mut invalid=params.clone();invalid["baseline"]["summary"]["total_heap_size"]=serde_json::json!(u64::MAX);
    assert!(hprof_analyzer::comparison::compare_snapshot_request(invalid).is_err());
    let mut invalid=params.clone();invalid["current"]["leak_suspects"][0]["retained_percentage"]=serde_json::json!(-1);
    assert!(hprof_analyzer::comparison::compare_snapshot_request(invalid).is_err());
    assert!(hprof_analyzer::comparison::compare_snapshot_request(serde_json::Value::Null).is_err());
}

#[test]
fn snapshot_protocol_accepts_full_width_identifiers_but_keeps_delta_range_guards() {
    let mut params=serde_json::json!({"baseline":comparison_snapshot(&build_second_test_state()),
        "current":comparison_snapshot(&build_test_state()),"baseline_label":"before","current_label":"after"});
    for side in ["baseline", "current"] {
        for suspect in params[side]["leak_suspects"].as_array_mut().unwrap() {
            suspect["object_id"]=serde_json::json!(u64::MAX);
        }
    }
    assert!(hprof_analyzer::comparison::compare_snapshot_request(params.clone()).is_ok());
    params["baseline"]["summary"]["total_heap_size"]=serde_json::json!(u64::MAX);
    assert!(hprof_analyzer::comparison::compare_snapshot_request(params).is_err());
}

// ============================================================================
// JOIN tests
// ============================================================================

#[test]
fn test_join_instances_class_histogram_all_tables() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances i JOIN class_histogram c ON class_name = class_name"
    ).unwrap();
    // Should join instances (4) with matching class_histogram entries
    assert!(result.rows.len() >= 1);
    assert!(result.columns.iter().any(|c: &String| c.starts_with("i.")));
    assert!(result.columns.iter().any(|c: &String| c.starts_with("c.")));
}

#[test]
fn test_left_join_nulls() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances i LEFT JOIN leak_suspects l ON class_name = class_name"
    ).unwrap();
    // All 4 instances returned; only CacheManager matches leak_suspects
    assert_eq!(result.rows.len(), 4);
    // Non-matching rows have null in right-side columns
    let right_start = result.columns.iter().position(|c: &String| c.starts_with("l.")).unwrap();
    let null_rows = result.rows.iter()
        .filter(|row| row[right_start].is_null())
        .count();
    assert_eq!(null_rows, 3);
}

#[test]
fn test_join_with_where_order_limit() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances i JOIN class_histogram c ON class_name = class_name \
         WHERE i.retained_size >= 2048 ORDER BY i.retained_size DESC LIMIT 1"
    ).unwrap();
    assert_eq!(result.rows.len(), 1);
    // Should be CacheManager (highest retained_size matching >= 2048)
    let class_col = result.columns.iter().position(|c| c == "i.class_name").unwrap();
    assert_eq!(result.rows[0][class_col], serde_json::json!("com.app.CacheManager"));
}

#[test]
fn test_inner_join_keyword() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances AS i INNER JOIN class_histogram AS c ON class_name = class_name"
    ).unwrap();
    assert!(result.rows.len() >= 1);
}

#[test]
fn test_join_class_histogram_leak_suspects() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM class_histogram c JOIN leak_suspects l ON class_name = class_name"
    ).unwrap();
    // Only CacheManager exists in both tables
    assert_eq!(result.rows.len(), 1);
}

// ============================================================================
// Subquery tests
// ============================================================================

#[test]
fn test_subquery_scalar_avg() {
    let state = build_test_state();
    // AVG(retained_size) = (2048 + 1024 + 1024 + 4096) / 4 = 2048.0
    let result = state.execute_query(
        "SELECT * FROM instances WHERE retained_size > (SELECT AVG(retained_size) FROM instances)"
    ).unwrap();
    // Only CacheManager(4096) > 2048
    assert_eq!(result.total_matched, 1);
    assert_eq!(result.rows[0][2], serde_json::json!("com.app.CacheManager"));
}

#[test]
fn test_subquery_in() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances WHERE class_name IN (SELECT class_name FROM leak_suspects)"
    ).unwrap();
    assert_eq!(result.total_matched, 1);
    assert_eq!(result.rows[0][2], serde_json::json!("com.app.CacheManager"));
}

#[test]
fn test_subquery_in_class_histogram() {
    let state = build_test_state();
    // Instance class_names that appear in class_histogram
    let result = state.execute_query(
        "SELECT * FROM instances WHERE class_name IN (SELECT class_name FROM class_histogram)"
    ).unwrap();
    // 3 of 4 instances match (ArrayList not in histogram)
    assert_eq!(result.total_matched, 3);
}

#[test]
fn test_scalar_subquery_multiple_rows_error() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances WHERE retained_size > (SELECT retained_size FROM instances)"
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("exactly one row"));
}

#[test]
fn test_subquery_scalar_min() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances WHERE retained_size > (SELECT MIN(retained_size) FROM instances)"
    ).unwrap();
    // MIN is 1024 (ArrayList or byte[]), so HashMap(2048) and CacheManager(4096) match
    assert_eq!(result.total_matched, 2);
}

// ============================================================================
// Pagination tests
// ============================================================================

#[test]
fn test_pagination_first_page() {
    let state = build_test_state();
    let result = state.execute_query_paged("SELECT * FROM instances", 1, 2).unwrap();
    assert_eq!(result.page, Some(1));
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.total_rows, Some(4));
    assert_eq!(result.total_pages, Some(2));
}

#[test]
fn test_pagination_second_page() {
    let state = build_test_state();
    let result = state.execute_query_paged("SELECT * FROM instances", 2, 2).unwrap();
    assert_eq!(result.page, Some(2));
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.total_rows, Some(4));
}

#[test]
fn test_pagination_beyond_last_page() {
    let state = build_test_state();
    let result = state.execute_query_paged("SELECT * FROM instances", 100, 2).unwrap();
    assert_eq!(result.page, Some(100));
    assert_eq!(result.rows.len(), 0);
    assert_eq!(result.total_pages, Some(2));
}

#[test]
fn test_pagination_page_size_1() {
    let state = build_test_state();
    let result = state.execute_query_paged("SELECT * FROM class_histogram", 1, 1).unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.total_pages, Some(3));
    assert_eq!(result.total_rows, Some(3));
}

#[test]
fn test_pagination_large_page_size() {
    let state = build_test_state();
    let result = state.execute_query_paged("SELECT * FROM instances", 1, 1000).unwrap();
    assert_eq!(result.rows.len(), 4);
    assert_eq!(result.total_pages, Some(1));
}

// ============================================================================
// Compare heaps tests
// ============================================================================

#[test]
fn test_compare_heaps_growth() {
    let state1 = build_test_state();
    let state2 = build_second_test_state();
    let diff = compare_heaps(&state1, &state2, "/tmp/baseline.hprof", "/tmp/current.hprof");

    // Heap size doubled: 8192 -> 16384
    assert_eq!(diff.summary_delta.current_total_heap_size, 16384);
    assert_eq!(diff.summary_delta.baseline_total_heap_size, 8192);
    assert!(diff.summary_delta.total_heap_size_delta > 0);

    // CacheManager should appear as grew
    let cache_diff = diff.histogram_delta.iter()
        .find(|d| d.class_name == "com.app.CacheManager");
    assert!(cache_diff.is_some());
    let cd = cache_diff.unwrap();
    assert!(cd.retained_size_delta > 0); // grew from 4096 to 8192

    // SessionStore should appear as new
    let session_diff = diff.histogram_delta.iter()
        .find(|d| d.class_name == "com.app.SessionStore");
    assert!(session_diff.is_some());
    assert_eq!(session_diff.unwrap().change_type, "new");
}

// ============================================================================
// Error handling tests
// ============================================================================

#[test]
fn test_join_unknown_table() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances i JOIN bogus_table b ON class_name = class_name"
    );
    assert!(result.is_err());
}

#[test]
fn test_subquery_invalid_syntax() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances WHERE class_name IN (bogus)"
    );
    assert!(result.is_err());
}

#[test]
fn test_join_unknown_column() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances i JOIN class_histogram c ON bogus_col = class_name"
    );
    assert!(result.is_err());
}

// ============================================================================
// Additional JOIN tests (coverage gaps)
// ============================================================================

#[test]
fn test_join_without_aliases() {
    let state = build_test_state();
    // JOIN without AS aliases — table names used as prefixes
    let result = state.execute_query(
        "SELECT * FROM instances JOIN class_histogram ON class_name = class_name"
    ).unwrap();
    assert!(result.rows.len() >= 1);
    // Columns should be prefixed with full table names
    assert!(result.columns.iter().any(|c: &String| c.starts_with("instances.")));
    assert!(result.columns.iter().any(|c: &String| c.starts_with("class_histogram.")));
}

#[test]
fn test_inner_join_zero_matches() {
    let state = build_test_state();
    // leak_suspects has only CacheManager; class_histogram has CacheManager, HashMap, byte[]
    // INNER JOIN on class_name between leak_suspects and class_histogram yields 1 match.
    // But if we filter for a non-existent class, we get 0 rows.
    let result = state.execute_query(
        "SELECT * FROM leak_suspects l JOIN class_histogram c ON class_name = class_name \
         WHERE l.class_name = 'nonexistent'"
    ).unwrap();
    assert_eq!(result.rows.len(), 0);
}

#[test]
fn test_join_one_to_many_cartesian() {
    // When one left row matches multiple right rows, we expect cartesian product behavior.
    // In our test data, CacheManager appears once in instances and once in class_histogram,
    // so 1:1. But class_histogram has 3 entries and leak_suspects has 1.
    // Use second test state which has 2 leak_suspects (CacheManager, SessionStore)
    // and 4 class_histogram entries.
    let state = build_second_test_state();
    let result = state.execute_query(
        "SELECT * FROM leak_suspects l JOIN class_histogram c ON class_name = class_name"
    ).unwrap();
    // CacheManager matches CacheManager (1), SessionStore matches SessionStore (1)
    assert_eq!(result.rows.len(), 2);
}

#[test]
fn test_join_projection_specific_columns() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT i.class_name, c.instance_count FROM instances i JOIN class_histogram c ON class_name = class_name"
    ).unwrap();
    assert_eq!(result.columns.len(), 2);
    assert!(result.columns.contains(&"i.class_name".to_string()));
    assert!(result.columns.contains(&"c.instance_count".to_string()));
    assert!(result.rows.len() >= 1);
}

#[test]
fn test_left_join_all_null_right_side() {
    let state = build_test_state();
    // LEFT JOIN instances with leak_suspects, filtering for non-CacheManager
    let result = state.execute_query(
        "SELECT * FROM instances i LEFT JOIN leak_suspects l ON class_name = class_name \
         WHERE i.class_name != 'com.app.CacheManager'"
    ).unwrap();
    // 3 non-CacheManager instances, all with null right side
    assert_eq!(result.rows.len(), 3);
    let right_start = result.columns.iter().position(|c: &String| c.starts_with("l.")).unwrap();
    for row in &result.rows {
        assert!(row[right_start].is_null());
    }
}

// ============================================================================
// Additional subquery tests (coverage gaps)
// ============================================================================

#[test]
fn test_subquery_scalar_max() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances WHERE retained_size = (SELECT MAX(retained_size) FROM instances)"
    ).unwrap();
    // MAX is 4096 (CacheManager)
    assert_eq!(result.total_matched, 1);
    assert_eq!(result.rows[0][2], serde_json::json!("com.app.CacheManager"));
}

#[test]
fn test_subquery_scalar_count() {
    let state = build_test_state();
    // COUNT(*) FROM class_histogram = 3
    let result = state.execute_query(
        "SELECT * FROM instances WHERE retained_size > (SELECT COUNT(*) FROM class_histogram)"
    ).unwrap();
    // All instances have retained_size > 3: 2048, 1024, 1024, 4096
    assert_eq!(result.total_matched, 4);
}

#[test]
fn test_subquery_scalar_sum() {
    let state = build_test_state();
    // SUM(retained_size) FROM leak_suspects = 4096
    let result = state.execute_query(
        "SELECT * FROM instances WHERE retained_size >= (SELECT SUM(retained_size) FROM leak_suspects)"
    ).unwrap();
    // Only CacheManager (4096) >= 4096
    assert_eq!(result.total_matched, 1);
    assert_eq!(result.rows[0][2], serde_json::json!("com.app.CacheManager"));
}

#[test]
fn test_subquery_in_empty_result() {
    let state = build_test_state();
    // Subquery returns 0 rows → IN (empty set) → no matches
    let result = state.execute_query(
        "SELECT * FROM instances WHERE class_name IN \
         (SELECT class_name FROM leak_suspects WHERE retained_size > 999999)"
    ).unwrap();
    assert_eq!(result.total_matched, 0);
    assert_eq!(result.rows.len(), 0);
}

#[test]
fn test_subquery_on_class_histogram_table() {
    let state = build_test_state();
    // Use subquery from class_histogram: classes with retained_size > 1024
    let result = state.execute_query(
        "SELECT * FROM class_histogram WHERE retained_size > \
         (SELECT AVG(retained_size) FROM class_histogram)"
    ).unwrap();
    // AVG = (4096 + 2048 + 1024) / 3 = 2389.33; CacheManager(4096) qualifies
    assert!(result.total_matched >= 1);
}

// ============================================================================
// Additional pagination tests (coverage gaps)
// ============================================================================

#[test]
fn test_pagination_page_zero_guard() {
    let state = build_test_state();
    // page=0 should be treated as page=1 (guard against u64 underflow)
    let result = state.execute_query_paged("SELECT * FROM instances", 0, 2).unwrap();
    assert_eq!(result.page, Some(1));
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.total_rows, Some(4));
}

#[test]
fn test_pagination_page_size_zero_guard() {
    let state = build_test_state();
    // page_size=0 should be treated as default (500), not cause division by zero
    let result = state.execute_query_paged("SELECT * FROM instances", 1, 0).unwrap();
    assert_eq!(result.page, Some(1));
    assert_eq!(result.rows.len(), 4); // all fit in default page size of 500
    assert_eq!(result.total_pages, Some(1));
}

#[test]
fn test_pagination_empty_result() {
    let state = build_test_state();
    // Query that returns 0 rows
    let result = state.execute_query_paged(
        "SELECT * FROM instances WHERE class_name = 'nonexistent'", 1, 10
    ).unwrap();
    assert_eq!(result.page, Some(1));
    assert_eq!(result.rows.len(), 0);
    assert_eq!(result.total_rows, Some(0));
    assert_eq!(result.total_pages, Some(1));
}

#[test]
fn test_pagination_with_where_filter() {
    let state = build_test_state();
    // WHERE narrows to 2 results, then paginate page_size=1
    let result = state.execute_query_paged(
        "SELECT * FROM instances WHERE retained_size >= 2048", 1, 1
    ).unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.total_rows, Some(2)); // HashMap(2048) and CacheManager(4096)
    assert_eq!(result.total_pages, Some(2));
}

#[test]
fn test_pagination_last_page_partial() {
    let state = build_test_state();
    // 4 rows, page_size=3 → page 2 should have 1 row
    let result = state.execute_query_paged("SELECT * FROM instances", 2, 3).unwrap();
    assert_eq!(result.page, Some(2));
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.total_rows, Some(4));
    assert_eq!(result.total_pages, Some(2));
}

// ============================================================================
// Additional compare_heaps tests (coverage gaps)
// ============================================================================

#[test]
fn test_compare_heaps_removed_class() {
    let state1 = build_test_state();
    let state2 = build_second_test_state();
    // Compare in reverse: state2 as baseline, state1 as current
    // SessionStore exists in state2 but not state1 → should be "removed"
    let diff = compare_heaps(&state2, &state1, "/tmp/current.hprof", "/tmp/baseline.hprof");

    let session_diff = diff.histogram_delta.iter()
        .find(|d| d.class_name == "com.app.SessionStore");
    assert!(session_diff.is_some());
    assert_eq!(session_diff.unwrap().change_type, "removed");
}

#[test]
fn test_compare_heaps_unchanged_class() {
    let state1 = build_test_state();
    let state2 = build_second_test_state();
    let diff = compare_heaps(&state1, &state2, "/tmp/baseline.hprof", "/tmp/current.hprof");

    // HashMap: same retained_size (2048) in both states
    let hashmap_diff = diff.histogram_delta.iter()
        .find(|d| d.class_name == "java.util.HashMap");
    assert!(hashmap_diff.is_some());
    let hd = hashmap_diff.unwrap();
    assert_eq!(hd.retained_size_delta, 0);
    assert_eq!(hd.change_type, "unchanged");
}

#[test]
fn test_compare_heaps_summary_fields() {
    let state1 = build_test_state();
    let state2 = build_second_test_state();
    let diff = compare_heaps(&state1, &state2, "/tmp/baseline.hprof", "/tmp/current.hprof");

    // Verify all summary delta fields
    assert_eq!(diff.summary_delta.baseline_total_heap_size, 8192);
    assert_eq!(diff.summary_delta.current_total_heap_size, 16384);
    assert_eq!(diff.summary_delta.total_heap_size_delta, 8192);

    // Verify baseline/current paths
    assert_eq!(diff.baseline_path, "/tmp/baseline.hprof");
    assert_eq!(diff.current_path, "/tmp/current.hprof");
}

#[test]
fn test_compare_heaps_identical() {
    let state1 = build_test_state();
    let state2 = build_test_state();
    let diff = compare_heaps(&state1, &state2, "/tmp/a.hprof", "/tmp/b.hprof");

    // Same state → 0 delta
    assert_eq!(diff.summary_delta.total_heap_size_delta, 0);
    // All classes should be "unchanged"
    for d in &diff.histogram_delta {
        assert_eq!(d.change_type, "unchanged", "Expected unchanged for {}", d.class_name);
    }
}

// ============================================================================
// Additional error handling tests (coverage gaps)
// ============================================================================

#[test]
fn test_subquery_on_unknown_table() {
    let state = build_test_state();
    let result = state.execute_query(
        "SELECT * FROM instances WHERE class_name IN (SELECT class_name FROM bogus_table)"
    );
    assert!(result.is_err());
}

#[test]
fn test_join_self_join_same_table() {
    let state = build_test_state();
    // Self-join: instances with itself on class_name
    let result = state.execute_query(
        "SELECT * FROM instances a JOIN instances b ON class_name = class_name"
    ).unwrap();
    // Each instance matches itself → at least 4 rows
    assert!(result.rows.len() >= 4);
}

#[test]
fn test_pagination_with_order_by() {
    let state = build_test_state();
    // ORDER BY + pagination: ensure order is applied before pagination
    let p1 = state.execute_query_paged(
        "SELECT * FROM instances ORDER BY retained_size DESC", 1, 2
    ).unwrap();
    let p2 = state.execute_query_paged(
        "SELECT * FROM instances ORDER BY retained_size DESC", 2, 2
    ).unwrap();
    assert_eq!(p1.rows.len(), 2);
    assert_eq!(p2.rows.len(), 2);
    // First page should have higher retained_size than second page
    let col_idx = p1.columns.iter().position(|c| c == "retained_size").unwrap();
    let p1_first = p1.rows[0][col_idx].as_u64().unwrap();
    let p2_last = p2.rows[1][col_idx].as_u64().unwrap();
    assert!(p1_first >= p2_last);
}
