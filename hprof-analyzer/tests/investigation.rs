//! Independent byte fixture and expected graph weights; no model or production capture.
use hprof_analyzer::{
    indexed::{
        storage::{load_structure, StorageMode, StorageOptions},
        HeapAnalysis, IndexedAnalysisState,
    },
    investigation::{Budget, Operation, Request, MAX_EDGES, MAX_NODES},
};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
fn id(out: &mut Vec<u8>, v: u32) {
    out.extend(v.to_be_bytes());
}
fn record(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
    out.push(tag);
    id(out, 0);
    id(out, body.len() as u32);
    out.extend(body);
}
fn class(heap: &mut Vec<u8>, address: u32, parent: u32, fields: &[u32]) {
    heap.push(0x20);
    id(heap, address);
    id(heap, 0);
    for v in [parent, 0, 0, 0, 0, 0] {
        id(heap, v);
    }
    id(heap, 0);
    heap.extend(0u16.to_be_bytes());
    heap.extend(0u16.to_be_bytes());
    heap.extend((fields.len() as u16).to_be_bytes());
    for f in fields {
        id(heap, *f);
        heap.push(2);
    }
}
fn instance(heap: &mut Vec<u8>, address: u32, class: u32, refs: &[u32]) {
    heap.push(0x21);
    id(heap, address);
    id(heap, 0);
    id(heap, class);
    id(heap, (refs.len() * 4) as u32);
    for r in refs {
        id(heap, *r);
    }
}
fn array(heap: &mut Vec<u8>, address: u32, n: u32) {
    heap.push(0x23);
    id(heap, address);
    id(heap, 0);
    id(heap, n);
    heap.push(8);
    heap.extend(vec![0x51; n as usize]);
}
fn fixture(wide: bool) -> Vec<u8> {
    let mut out = b"JAVA PROFILE 1.0.2\0".to_vec();
    id(&mut out, 4);
    out.extend(0u64.to_be_bytes());
    for (name, text) in [
        (1, "left"),
        (2, "right"),
        (3, "referent"),
        (10, "java/lang/Object"),
        (11, "example/Owner"),
        (12, "java/lang/ref/Reference"),
        (13, "java/lang/ref/WeakReference"),
        (14, "[B"),
    ] {
        let mut body = Vec::new();
        id(&mut body, name);
        body.extend(text.as_bytes());
        record(&mut out, 1, &body);
    }
    for (serial, address, name) in [
        (1, 100, 10),
        (2, 110, 11),
        (3, 120, 12),
        (4, 130, 13),
        (5, 140, 14),
    ] {
        let mut body = Vec::new();
        for v in [serial, address, 0, name] {
            id(&mut body, v);
        }
        record(&mut out, 2, &body);
    }
    let mut heap = Vec::new();
    class(&mut heap, 100, 0, &[]);
    class(&mut heap, 110, 100, &[1, 2]);
    class(&mut heap, 120, 100, &[3]);
    class(&mut heap, 130, 120, &[]);
    class(&mut heap, 140, 100, &[]);
    heap.push(0xff);
    id(&mut heap, 200);
    heap.push(0xff);
    id(&mut heap, 700);
    instance(&mut heap, 200, 110, &[300, 400]);
    instance(&mut heap, 300, 110, &[500, 600]);
    instance(&mut heap, 400, 110, &[500, 0]);
    instance(&mut heap, 600, 110, &[200, 0]);
    instance(&mut heap, 700, 130, &[800]);
    array(&mut heap, 500, 32);
    array(&mut heap, 800, 8);
    array(&mut heap, 900, 8);
    if wide {
        for n in 10000..16000 {
            instance(&mut heap, n, 110, &[500, 0]);
        }
    }
    record(&mut out, 0x1c, &heap);
    out
}
fn read(state: &dyn HeapAnalysis, operation: Operation, object: u64) -> (Value, Budget) {
    let mut budget = Budget::new(Arc::new(AtomicBool::new(false)));
    let result = state
        .investigate_metadata(
            &Request {
                operation,
                object_id: object.to_string(),
            },
            &mut budget,
        )
        .unwrap();
    (result, budget)
}
#[test]
fn deterministic_diamond_cycle_weak_and_unreachable_controls_match_across_storage_modes() {
    let bytes = fixture(false);
    let mut map = memmap2::MmapMut::map_anon(bytes.len()).unwrap();
    map.copy_from_slice(&bytes);
    let map = Arc::new(map.make_read_only().unwrap());
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut baseline = None;
    for (mode, status) in [
        (StorageMode::Memory, "disabled"),
        (StorageMode::Disk, "built"),
        (StorageMode::Disk, "reused"),
    ] {
        let options = StorageOptions {
            mode,
            cache_dir: Some(root.path().into()),
            edge_buffer_bytes: 1024 * 1024,
        };
        let (one, two, report) =
            load_structure(map.clone(), &options, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.cache_status, status);
        let state = IndexedAnalysisState::from_phases(one, two).unwrap();
        let mut results = Vec::new();
        // This control deliberately has four-byte IDs: an eight-byte header,
        // two four-byte references, and eight-byte alignment make Owner 16 B.
        // The diamond shares array 500; the cycle does not duplicate its weight.
        for (object, shallow, retained) in [
            (200, 16, 112),
            (300, 16, 32),
            (400, 16, 16),
            (600, 16, 16),
            (500, 48, 48),
            (800, 24, 0),
            (900, 24, 0),
        ] {
            let (r, _) = read(&state, Operation::Object, object);
            assert_eq!(r["selected"]["object_id"], object.to_string());
            assert_eq!(r["selected"]["shallow_size"], shallow.to_string());
            assert_eq!(
                r["selected"]["retained_size"],
                retained.to_string(),
                "retained object {object}"
            );
            results.push(r);
        }
        let (path, _) = read(&state, Operation::RootPath, 500);
        assert_eq!(path["status"], "found");
        assert_eq!(
            path["rows"].as_array().unwrap().last().unwrap()["object_id"],
            "500"
        );
        for target in [800, 900] {
            let (r, _) = read(&state, Operation::RootPath, target);
            assert_eq!(r["status"], "no_path_found");
        }
        let (fields, _) = read(&state, Operation::Fields, 200);
        assert_eq!(fields["rows"].as_array().unwrap().len(), 2);
        assert!(fields.to_string().contains("left"));
        assert!(!fields.to_string().contains("primitive_value"));
        let (refs, _) = read(&state, Operation::Referrers, 500);
        let ids: Vec<_> = refs["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["object_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["300", "400"]);
        if let Some(before) = &baseline {
            assert_eq!(before, &results);
        } else {
            baseline = Some(results);
        }
    }
}
#[test]
fn wide_reverse_graph_is_bounded_and_cancellation_is_not_a_false_no_path() {
    let bytes = fixture(true);
    let state = IndexedAnalysisState::from_parse_result(
        hprof_analyzer::indexed::parse::parse_indexed(&bytes).unwrap(),
    )
    .unwrap();
    let (r, budget) = read(&state, Operation::RootPath, 500);
    assert_eq!(r["status"], "budget_exhausted");
    assert_eq!(r["truncated"], true);
    assert!(budget.nodes <= MAX_NODES && budget.edges <= MAX_EDGES);
    let (r, _) = read(&state, Operation::Referrers, 500);
    assert_eq!(r["rows"].as_array().unwrap().len(), 32);
    assert_eq!(r["truncated"], true);
    assert_eq!(r["total"], "6002");
    let cancel = Arc::new(AtomicBool::new(false));
    let mut budget = Budget::new(cancel.clone());
    cancel.store(true, Ordering::Relaxed);
    assert!(state
        .investigate_metadata(
            &Request {
                operation: Operation::RootPath,
                object_id: "500".into()
            },
            &mut budget
        )
        .is_err());
    assert_eq!(budget.nodes, 0);
}
