//! Process-boundary checks. Byte fixtures are generated here, never user dumps.
use hprof_analyzer::indexed::{HeapAnalysis, IndexedAnalysisState};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use tempfile::TempDir;

fn record(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
}
fn fixture(arrays: &[(u64, u32, u8)]) -> Vec<u8> {
    let mut out = b"JAVA PROFILE 1.0.2\0".to_vec();
    out.extend_from_slice(&8u32.to_be_bytes());
    out.extend_from_slice(&0u64.to_be_bytes());
    let mut heap = Vec::new();
    for &(id, count, kind) in arrays {
        heap.push(0xff);
        heap.extend_from_slice(&id.to_be_bytes());
        heap.push(0x23);
        heap.extend_from_slice(&id.to_be_bytes());
        heap.extend_from_slice(&0u32.to_be_bytes());
        heap.extend_from_slice(&count.to_be_bytes());
        heap.push(kind);
        let width = match kind {
            8 => 1,
            11 => 8,
            _ => panic!("fixture kind"),
        };
        heap.extend(std::iter::repeat_n(b'x', count as usize * width));
    }
    record(&mut out, 0x1c, &heap);
    record(&mut out, 0x2c, &[]);
    out
}
fn write(dir: &TempDir, name: &str, arrays: &[(u64, u32, u8)]) -> std::path::PathBuf {
    let path = dir.path().join(name);
    fs::write(&path, fixture(arrays)).unwrap();
    path
}
fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_heaplens"))
        .env("DO_NOT_TRACK", "1")
        .args(args)
        .output()
        .unwrap()
}
fn path(path: &Path) -> &str {
    path.to_str().unwrap()
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn telemetry_choices_and_local_diagnostics_are_explicit_filtered_and_create_new() {
    let dir=TempDir::new().unwrap();
    let heap=write(&dir,"private-canary.hprof",&[(512,9,8)]);
    let report=dir.path().join("local-diagnostics.json");
    let output=run(&["analyze",path(&heap),"--quiet","--format","json","--diagnostics",path(&report)]);
    let result=success(output);assert_eq!(result["privacy"]["telemetry_level"],"off");assert_eq!(result["privacy"]["network_requests"],false);
    let raw=fs::read_to_string(&report).unwrap();let diagnostic:Value=serde_json::from_str(&raw).unwrap();
    assert_eq!(diagnostic["level"],"off");assert!(!raw.contains("private-canary"));assert!(diagnostic["events"].as_array().unwrap().iter().any(|e|e["name"]=="analysis/completed"));
    assert_eq!(run(&["analyze",path(&heap),"--diagnostics",path(&heap)]).status.code(),Some(6));
    assert_eq!(fs::read(&heap).unwrap(),fixture(&[(512,9,8)]));
    assert_eq!(run(&["analyze",path(&heap),"--diagnostics",path(&report)]).status.code(),Some(6));assert_eq!(fs::read_to_string(&report).unwrap(),raw);
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;assert_eq!(fs::metadata(&report).unwrap().permissions().mode()&0o777,0o600);}
}

#[test]
fn do_not_track_and_ci_force_off_even_when_cli_opt_in_is_supplied() {
    let dir=TempDir::new().unwrap();let heap=write(&dir,"private-canary.hprof",&[(512,9,8)]);
    for key in ["DO_NOT_TRACK","CI"] {
        let output=Command::new(env!("CARGO_BIN_EXE_heaplens")).env(key,"1")
            .args(["analyze",path(&heap),"--quiet","--format","json","--telemetry","all"]).output().unwrap();
        assert_eq!(success(output)["privacy"]["telemetry_level"],"off");
    }
    assert_eq!(run(&["analyze",path(&heap),"--telemetry","private-canary"]).status.code(),Some(2));
}

#[test]
fn browser_help_and_invalid_host_options_do_not_analyze_or_overwrite() {
    let help = run(&["open", "--help"]);
    assert!(help.status.success());
    let text = String::from_utf8_lossy(&help.stdout);
    for option in ["--source-root", "--server", "--node", "--ui-host", "--no-browser", "--port"] {
        assert!(text.contains(option));
    }
    assert_eq!(run(&["open", "missing.hprof", "--port", "65536"]).status.code(), Some(2));
    assert_eq!(run(&["open", "missing.hprof", "--format", "json"]).status.code(), Some(2));
    assert_eq!(run(&["open", "missing.hprof", "--server", "missing-server"]).status.code(), Some(3));
}

#[test]
fn analyze_matches_shared_engine_in_both_backends() {
    let dir = TempDir::new().unwrap();
    let p = write(
        &dir,
        "heap with spaces.hprof",
        &[(0x200, 9, 8), (0x300, 3, 11)],
    );
    let bytes = fs::read(&p).unwrap();
    for backend in ["indexed", "legacy"] {
        let state: Box<dyn HeapAnalysis> = if backend == "indexed" {
            Box::new(
                IndexedAnalysisState::from_parse_result(
                    hprof_analyzer::indexed::parse::parse_indexed(&bytes).unwrap(),
                )
                .unwrap(),
            )
        } else {
            let (graph, waste) = hprof_analyzer::build_graph(&bytes).unwrap();
            Box::new(
                hprof_analyzer::calculate_dominators_with_state(graph, waste)
                    .unwrap()
                    .1,
            )
        };
        let report = success(run(&[
            "analyze",
            path(&p),
            "--format",
            "json",
            "--backend",
            backend,
            "--rows",
            "1",
        ]));
        assert_eq!(report["schema_version"], 1);
        assert_eq!(report["status"], "completed");
        assert_eq!(report["data"]["summary"], json!(state.get_summary()));
        assert_eq!(
            report["data"]["class_histogram"].as_array().unwrap().len(),
            1
        );
        assert_eq!(report["data"]["selection"]["class_histogram_total"], 2);
        assert_eq!(report["data"]["truncated"], true);
        assert_eq!(report["privacy"]["network_requests"], false);
        assert!(!report.to_string().contains(path(&p)));
        assert!(report["data"]["waste_totals"]
            .get("duplicate_strings")
            .is_none());
    }
}

#[test]
fn json_stdout_is_one_document_and_quiet_only_suppresses_progress() {
    let dir = TempDir::new().unwrap();
    let p = write(&dir, "heap.hprof", &[(0x200, 1, 8)]);
    let out = run(&["analyze", path(&p), "--format", "json"]);
    assert!(String::from_utf8_lossy(&out.stderr).contains("[HeapLens]"));
    success(out);
    let out = run(&["analyze", path(&p), "--format", "json", "--quiet"]);
    assert!(out.stderr.is_empty());
    success(out);
}

#[test]
fn queries_paginate_after_execution_and_keep_aggregate_input() {
    let dir = TempDir::new().unwrap();
    let p = write(&dir, "heap.hprof", &[(0x200, 1, 8), (0x300, 1, 8)]);
    let query = "SELECT object_id, retained_size FROM instances ORDER BY object_id";
    for page in ["1", "2", "3"] {
        let report = success(run(&[
            "query",
            path(&p),
            query,
            "--page",
            page,
            "--rows",
            "1",
            "--format",
            "json",
        ]));
        let result = &report["data"]["result"];
        assert_eq!(result["total_rows"], 2);
        assert_eq!(result["total_pages"], 2);
        if page == "3" {
            assert!(result["rows"].as_array().unwrap().is_empty());
        } else {
            assert!(result["rows"][0][0].is_string());
        }
    }
    let report = success(run(&[
        "query",
        path(&p),
        "SELECT COUNT(*) FROM instances",
        "--rows",
        "1",
        "--format",
        "json",
    ]));
    assert_eq!(report["data"]["result"]["rows"][0][0], "2");
}

#[test]
fn full_u64_ids_work_for_special_commands_and_decimal_selection() {
    let dir = TempDir::new().unwrap();
    let ids = [9007199254740992u64, 9007199254740993, u64::MAX];
    let p = write(&dir, "ids.hprof", &ids.map(|id| (id, 1, 8)));
    for backend in ["indexed", "legacy"] {
        for id in ids {
            for query in [
                format!(":info {id}"),
                format!("SELECT object_id FROM instances WHERE object_id = {id}"),
            ] {
                let report = success(run(&[
                    "query",
                    path(&p),
                    &query,
                    "--format",
                    "json",
                    "--backend",
                    backend,
                ]));
                let result = &report["data"]["result"];
                let index = result["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|c| c == "object_id")
                    .unwrap();
                assert_eq!(result["rows"].as_array().unwrap().len(), 1);
                assert_eq!(result["rows"][0][index], id.to_string());
            }
        }
    }
}

#[test]
fn comparison_is_current_minus_baseline_preserves_models_and_hides_paths() {
    let dir = TempDir::new().unwrap();
    let a = write(&dir, "before.hprof", &[(0x200, 1, 8)]);
    let b = write(&dir, "after.hprof", &[(0x200, 100, 8)]);
    for backend in ["indexed", "legacy"] {
        let run_compare = |a: &Path, b: &Path| {
            success(run(&[
                "compare",
                path(a),
                path(b),
                "--format",
                "json",
                "--backend",
                backend,
            ]))
        };
        let forward = run_compare(&a, &b);
        let reverse = run_compare(&b, &a);
        let same = run_compare(&a, &a);
        let delta = forward["data"]["comparison"]["summary_delta"]["total_heap_size_delta"]
            .as_i64()
            .unwrap();
        assert!(delta > 0);
        assert_eq!(
            reverse["data"]["comparison"]["summary_delta"]["total_heap_size_delta"],
            -delta
        );
        assert_eq!(
            same["data"]["comparison"]["summary_delta"]["total_heap_size_delta"],
            0
        );
        assert!(forward["data"]["baseline_summary"]
            .get("size_model")
            .is_some());
        assert!(!forward.to_string().contains(path(&a)));
        assert!(!forward.to_string().contains(path(&b)));
    }
}

#[test]
fn output_file_is_create_new_and_never_overwrites_dump_or_report() {
    let dir = TempDir::new().unwrap();
    let p = write(&dir, "heap.hprof", &[(0x200, 1, 8)]);
    let before = fs::read(&p).unwrap();
    let report = dir.path().join("report.json");
    let out = run(&[
        "analyze",
        path(&p),
        "--format",
        "json",
        "--output",
        path(&report),
    ]);
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    let saved = fs::read(&report).unwrap();
    let _: Value = serde_json::from_slice(&saved).unwrap();
    for destination in [&p, &report] {
        let out = run(&["analyze", path(&p), "--output", path(destination)]);
        assert_eq!(out.status.code(), Some(6));
    }
    assert_eq!(fs::read(&p).unwrap(), before);
    assert_eq!(fs::read(&report).unwrap(), saved);
    let missing_parent = dir.path().join("missing/report.json");
    assert_eq!(
        run(&["analyze", path(&p), "--output", path(&missing_parent)])
            .status
            .code(),
        Some(6)
    );
}

#[cfg(unix)]
#[test]
fn output_aliases_cannot_overwrite_input_and_new_reports_are_private() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = TempDir::new().unwrap();
    let p = write(&dir, "heap.hprof", &[(0x200, 1, 8)]);
    let hard = dir.path().join("hard");
    let soft = dir.path().join("soft");
    fs::hard_link(&p, &hard).unwrap();
    symlink(&p, &soft).unwrap();
    for destination in [&hard, &soft] {
        assert_eq!(
            run(&["analyze", path(&p), "--output", path(destination)])
                .status
                .code(),
            Some(6)
        );
    }
    let report = dir.path().join("private.json");
    assert!(run(&["analyze", path(&p), "--output", path(&report)])
        .status
        .success());
    assert_eq!(
        fs::metadata(report).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn bad_inputs_and_queries_have_stable_exits_without_raw_data() {
    let dir = TempDir::new().unwrap();
    let p = write(&dir, "heap.hprof", &[(0x200, 1, 8)]);
    let missing = dir.path().join("PRIVATE_PATH_MARKER");
    let out = run(&["analyze", path(&missing), "--quiet", "--format", "json"]);
    assert_eq!(out.status.code(), Some(3));
    assert!(out.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stderr).unwrap()["code"],
        "input_unavailable"
    );
    assert!(!String::from_utf8_lossy(&out.stderr).contains("PRIVATE_PATH_MARKER"));
    for q in [
        "SELECT * FROM PRIVATE_QUERY_MARKER",
        ":info 18446744073709551616",
        "SELECT * FROM instances WHERE retained_size > 18446744073709551615KB",
    ] {
        let out = run(&["query", path(&p), q, "--quiet", "--format", "json"]);
        assert_eq!(out.status.code(), Some(5));
        assert!(out.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains(q));
    }
    assert_eq!(run(&["query", path(&p), ""]).status.code(), Some(2));
    assert_eq!(
        run(&["query", path(&p), &"a".repeat(16385)]).status.code(),
        Some(2)
    );
    assert_eq!(run(&["analyze", path(dir.path())]).status.code(), Some(3));
}

#[test]
fn malformed_headers_records_and_overflowing_array_counts_fail_closed() {
    let dir = TempDir::new().unwrap();
    let p = dir.path().join("bad.hprof");
    let valid = fixture(&[(0x200, 1, 8)]);
    let mut wrong = valid.clone();
    wrong[0] = b'X';
    let mut unfinished = valid.clone();
    unfinished.truncate(unfinished.len() - 9);
    let mut overflow = b"JAVA PROFILE 1.0.2\0".to_vec();
    overflow.extend_from_slice(&8u32.to_be_bytes());
    overflow.extend_from_slice(&0u64.to_be_bytes());
    let mut heap = vec![0x23];
    heap.extend_from_slice(&512u64.to_be_bytes());
    heap.extend_from_slice(&0u32.to_be_bytes());
    heap.extend_from_slice(&(1u32 << 29).to_be_bytes());
    heap.push(11);
    record(&mut overflow, 0x1c, &heap);
    record(&mut overflow, 0x2c, &[]);
    for bytes in [
        vec![],
        b"PRIVATE_RAW_MARKER".to_vec(),
        valid[..31].to_vec(),
        wrong,
        unfinished,
        valid[..valid.len() - 1].to_vec(),
        overflow,
    ] {
        fs::write(&p, &bytes).unwrap();
        for backend in ["indexed", "legacy"] {
            let out = run(&[
                "analyze",
                path(&p),
                "--format",
                "json",
                "--quiet",
                "--backend",
                backend,
            ]);
            assert!(
                matches!(out.status.code(), Some(3 | 4)),
                "{:?}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(out.stdout.is_empty());
            assert!(!String::from_utf8_lossy(&out.stderr).contains("PRIVATE_RAW_MARKER"));
        }
    }
}

#[test]
fn help_version_and_argument_errors_do_not_analyze() {
    assert!(run(&["--help"]).status.success());
    assert!(run(&["--version"]).status.success());
    assert_eq!(run(&[]).status.code(), Some(2));
    assert_eq!(
        run(&["analyze", "x", "--rows", "10001"]).status.code(),
        Some(2)
    );
}

#[test]
fn unsupported_class_constant_pool_is_an_error_not_a_panic() {
    let dir = TempDir::new().unwrap();
    let p = dir.path().join("pool.hprof");
    let mut out = b"JAVA PROFILE 1.0.2\0".to_vec();
    out.extend_from_slice(&8u32.to_be_bytes());
    out.extend_from_slice(&0u64.to_be_bytes());
    let mut heap = vec![0x20];
    heap.extend_from_slice(&0x100u64.to_be_bytes());
    heap.extend_from_slice(&0u32.to_be_bytes());
    for _ in 0..6 {
        heap.extend_from_slice(&0u64.to_be_bytes());
    }
    heap.extend_from_slice(&16u32.to_be_bytes());
    heap.extend_from_slice(&1u16.to_be_bytes());
    record(&mut out, 0x1c, &heap);
    record(&mut out, 0x2c, &[]);
    fs::write(&p, out).unwrap();
    for backend in ["indexed", "legacy"] {
        let out = run(&[
            "analyze",
            path(&p),
            "--quiet",
            "--format",
            "json",
            "--backend",
            backend,
        ]);
        assert_eq!(
            out.status.code(),
            Some(4),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&out.stderr).unwrap()["code"],
            "invalid_heap"
        );
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn closing_output_pipe_is_a_clean_exit() {
    use std::process::Stdio;
    let dir = TempDir::new().unwrap();
    let p = write(&dir, "heap.hprof", &[(0x200, 1, 8)]);
    let mut child = Command::new(env!("CARGO_BIN_EXE_heaplens"))
        .env("DO_NOT_TRACK", "1")
        .args(["analyze", path(&p), "--quiet", "--format", "json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
}

#[test]
fn shared_heapql_integer_ordering_and_subqueries_do_not_round_adjacent_ids() {
    let mut state = hprof_analyzer::test_helpers::build_test_state();
    for (index, id) in [(2, 9007199254740993u64), (3, 9007199254740992)] {
        let old = state.node_data_map[index].0;
        state.id_to_node.remove(&old);
        state.node_data_map[index].0 = id;
        state
            .id_to_node
            .insert(id, petgraph::graph::NodeIndex::new(index));
    }
    let result = state
        .execute_query(
            "SELECT object_id FROM instances WHERE object_id > 9007199254740991 ORDER BY object_id",
        )
        .unwrap();
    assert_eq!(
        result.rows,
        vec![
            vec![json!(9007199254740992u64)],
            vec![json!(9007199254740993u64)]
        ]
    );
    let result=state.execute_query("SELECT object_id FROM instances WHERE object_id IN (SELECT object_id FROM instances WHERE object_id = 9007199254740993)").unwrap();
    assert_eq!(result.rows, vec![vec![json!(9007199254740993u64)]]);
    assert!(state.execute_query(":info 18446744073709551616").is_err());
}
