//! Independent byte-level graph oracle. A live instance keeps its runtime
//! class alive; an empty reference array does too. Class headers contain real
//! signer/protection-domain references, not Java instance fields.
use hprof_analyzer::indexed::{
    parse::parse_indexed,
    storage::{load_structure, StorageMode, StorageOptions},
    HeapAnalysis, IndexedAnalysisState,
};
use std::sync::{atomic::AtomicBool, Arc};

fn id(out: &mut Vec<u8>, value: u32) {
    out.extend(value.to_be_bytes());
}
fn record(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
    out.push(tag);
    id(out, 0);
    id(out, body.len() as u32);
    out.extend(body);
}
fn class(
    heap: &mut Vec<u8>,
    address: u32,
    parent: u32,
    loader: u32,
    signers: u32,
    protection: u32,
    field: bool,
    static_value: u32,
) {
    heap.push(0x20);
    id(heap, address);
    id(heap, 0);
    for value in [parent, loader, signers, protection, 0, 0] {
        id(heap, value);
    }
    id(heap, 0);
    heap.extend(0u16.to_be_bytes()); // producer size is not a layout oracle
    heap.extend(u16::from(static_value != 0).to_be_bytes());
    if static_value != 0 {
        id(heap, 1);
        heap.push(2);
        id(heap, static_value);
    }
    heap.extend(u16::from(field).to_be_bytes());
    if field {
        id(heap, 1);
        heap.push(2);
    }
}
fn instance(heap: &mut Vec<u8>, address: u32, class: u32, value: Option<u32>) {
    heap.push(0x21);
    id(heap, address);
    id(heap, 0);
    id(heap, class);
    id(heap, if value.is_some() { 4 } else { 0 });
    if let Some(value) = value {
        id(heap, value);
    }
}
fn fixture() -> Vec<u8> {
    let mut bytes = b"JAVA PROFILE 1.0.2\0".to_vec();
    id(&mut bytes, 4);
    bytes.extend(0u64.to_be_bytes());
    let mut name = 1u32.to_be_bytes().to_vec();
    name.extend(b"payload");
    record(&mut bytes, 1, &name);
    for (n, (address, text)) in [
        (0x100, "java/lang/Object"),
        (0x110, "example/Owner"),
        (0x120, "[Lexample/Owner;"),
        (0x130, "[B"),
        (0x140, "java/lang/Class"),
    ]
    .iter()
    .enumerate()
    {
        let name_id = 10 + n as u32;
        let mut name = name_id.to_be_bytes().to_vec();
        name.extend(text.as_bytes());
        record(&mut bytes, 1, &name);
        let mut load = (n as u32 + 1).to_be_bytes().to_vec();
        id(&mut load, *address);
        id(&mut load, 0);
        id(&mut load, name_id);
        record(&mut bytes, 2, &load);
    }
    let mut heap = Vec::new();
    // System-class roots may legally precede their ClassDump records.
    heap.push(0x05); id(&mut heap, 0x100);
    class(&mut heap, 0x100, 0, 0, 0, 0, false, 0);
    class(&mut heap, 0x110, 0x100, 0x400, 0x410, 0x420, true, 0x900);
    class(&mut heap, 0x120, 0x100, 0x400, 0, 0, false, 0);
    class(&mut heap, 0x130, 0x100, 0, 0, 0, false, 0);
    class(&mut heap, 0x140, 0x100, 0, 0, 0, false, 0);
    for root in [0x500, 0x501, 0x600] {
        heap.push(0xff);
        id(&mut heap, root);
    }
    for address in [0x400, 0x410, 0x420] {
        instance(&mut heap, address, 0x100, None);
    }
    instance(&mut heap, 0x500, 0x110, Some(0x900));
    instance(&mut heap, 0x501, 0x110, Some(0));
    heap.push(0x22);
    id(&mut heap, 0x600);
    id(&mut heap, 0);
    id(&mut heap, 0);
    id(&mut heap, 0x120);
    heap.push(0x23);
    id(&mut heap, 0x900);
    id(&mut heap, 0);
    id(&mut heap, 1);
    heap.push(8);
    heap.push(7);
    record(&mut bytes, 0x1c, &heap);
    record(&mut bytes, 0x2c, &[]);
    bytes
}
fn assert_retention(state: &dyn HeapAnalysis) {
    // Either owner keeps the same class/static payload alive. Neither owns it exclusively.
    for owner in [0x500, 0x501] {
        assert_eq!(state.get_object_info(owner).unwrap().0.retained_size, 16);
    }
    for metadata_target in [0x400, 0x410, 0x420] {
        assert!(
            state.gc_root_path(metadata_target, 20).is_some(),
            "missing path to {metadata_target:x}"
        );
        assert_eq!(
            state
                .get_object_info(metadata_target)
                .unwrap()
                .0
                .retained_size,
            8
        );
    }
    // Two 16-byte owners + 16-byte empty array + three 8-byte objects + 16-byte byte[1].
    assert_eq!(state.get_summary().reachable_heap_size, 88);
    assert_eq!(state.get_object_info(0x900).unwrap().2, 2);
}
#[test]
fn live_instance_and_empty_array_preserve_class_metadata_edges() {
    let bytes = fixture();
    let parsed = parse_indexed(&bytes).unwrap();
    assert_eq!(parsed.summary.total_classes, 5);
    assert_eq!(parsed.node_store.get_by_id(0x100).unwrap().node_type,
        hprof_analyzer::indexed::node_store::NodeType::Class);
    for (source, target) in [
        (0x500, 0x110),
        (0x501, 0x110),
        (0x600, 0x120),
        (0x900, 0x130),
        (0x110, 0x410),
        (0x110, 0x420),
        (0x110, 0x140),
    ] {
        let source = parsed.node_store.index_of(source).unwrap();
        let target = parsed.node_store.index_of(target).unwrap();
        assert!(
            parsed.edge_store.neighbors(source).contains(&target),
            "missing class edge {source}->{target}"
        );
    }
    assert_retention(&IndexedAnalysisState::from_parse_result(parsed).unwrap());
    let (legacy, waste) = hprof_analyzer::build_graph(&bytes).unwrap();
    let (_, legacy) = hprof_analyzer::calculate_dominators_with_state(legacy, waste).unwrap();
    assert_retention(&legacy);
}
#[test]
fn class_retention_is_identical_in_memory_disk_build_and_reopen() {
    let bytes = fixture();
    let mut mapping = memmap2::MmapMut::map_anon(bytes.len()).unwrap();
    mapping.copy_from_slice(&bytes);
    let mapping = Arc::new(mapping.make_read_only().unwrap());
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    for (mode, expected) in [
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
            load_structure(mapping.clone(), &options, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.cache_status, expected);
        assert_retention(&IndexedAnalysisState::from_phases(one, two).unwrap());
    }
}
