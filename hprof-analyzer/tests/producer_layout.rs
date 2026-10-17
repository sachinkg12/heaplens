//! Independently encoded metadata/graph controls. Physical expectations come
//! from separate JVM Instrumentation captures, not the sizing implementation.
use hprof_analyzer::{
    build_graph,
    indexed::{
        parse::parse_indexed,
        storage::{load_structure, StorageMode, StorageOptions},
    },
};
use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Arc},
};

const OBJECT: u64 = 0x2000;
const LOADER: u64 = 0x2100;
const THREAD: u64 = 0x2200;
const STRING: u64 = 0x2300;
const SYSTEM: u64 = 0x2400;
const PROPERTIES: u64 = 0x2500;
const MAP: u64 = 0x2600;
const NODE: u64 = 0x2700;
const ARRAY: u64 = 0x2800;
const CHILD: u64 = 0x2900;
const TARGET_LOADER: u64 = 0xa000;
const TARGET_THREAD: u64 = 0xa100;

struct Fixture {
    out: Vec<u8>,
    heap: Vec<u8>,
    symbols: HashMap<String, u64>,
    next: u64,
}
impl Fixture {
    fn new() -> Self {
        let mut out = b"JAVA PROFILE 1.0.2\0".to_vec();
        out.extend(8u32.to_be_bytes());
        out.extend(0u64.to_be_bytes());
        Self {
            out,
            heap: Vec::new(),
            symbols: HashMap::new(),
            next: 1,
        }
    }
    fn record(&mut self, tag: u8, body: &[u8]) {
        self.out.push(tag);
        self.out.extend(0u32.to_be_bytes());
        self.out.extend((body.len() as u32).to_be_bytes());
        self.out.extend(body);
    }
    fn symbol(&mut self, name: &str) -> u64 {
        if let Some(&id) = self.symbols.get(name) {
            return id;
        }
        let id = self.next;
        self.next += 1;
        self.symbols.insert(name.to_owned(), id);
        let mut body = id.to_be_bytes().to_vec();
        body.extend(name.as_bytes());
        self.record(1, &body);
        id
    }
    fn class(
        &mut self,
        id: u64,
        name: &str,
        parent: u64,
        loader: u64,
        fields: &[(&str, u8)],
        statics: &[(&str, u64)],
    ) {
        let name = self.symbol(name);
        let mut load = (id as u32).to_be_bytes().to_vec();
        load.extend(id.to_be_bytes());
        load.extend(0u32.to_be_bytes());
        load.extend(name.to_be_bytes());
        self.record(2, &load);
        self.heap.push(0x20);
        self.heap.extend(id.to_be_bytes());
        self.heap.extend(0u32.to_be_bytes());
        for v in [parent, loader, 0, 0, 0, 0] {
            self.heap.extend(v.to_be_bytes());
        }
        self.heap.extend(0u32.to_be_bytes());
        self.heap.extend(0u16.to_be_bytes());
        self.heap.extend((statics.len() as u16).to_be_bytes());
        for (name, value) in statics {
            let name = self.symbol(name);
            self.heap.extend(name.to_be_bytes());
            self.heap.push(2);
            self.heap.extend(value.to_be_bytes());
        }
        self.heap.extend((fields.len() as u16).to_be_bytes());
        for (name, kind) in fields {
            let name = self.symbol(name);
            self.heap.extend(name.to_be_bytes());
            self.heap.push(*kind);
        }
    }
    fn instance(&mut self, id: u64, class: u64, body: &[u8]) {
        self.heap.push(0x21);
        self.heap.extend(id.to_be_bytes());
        self.heap.extend(0u32.to_be_bytes());
        self.heap.extend(class.to_be_bytes());
        self.heap.extend((body.len() as u32).to_be_bytes());
        self.heap.extend(body);
    }
    fn array(&mut self, id: u64, values: &[u64]) {
        self.heap.push(0x22);
        self.heap.extend(id.to_be_bytes());
        self.heap.extend(0u32.to_be_bytes());
        self.heap.extend((values.len() as u32).to_be_bytes());
        self.heap.extend(ARRAY.to_be_bytes());
        for v in values {
            self.heap.extend(v.to_be_bytes());
        }
    }
    fn string(&mut self, id: u64, value: &str) {
        let mut body = (id + 0x10).to_be_bytes().to_vec();
        body.push(0);
        self.instance(id, STRING, &body);
        self.heap.push(0x23);
        self.heap.extend((id + 0x10).to_be_bytes());
        self.heap.extend(0u32.to_be_bytes());
        self.heap.extend((value.len() as u32).to_be_bytes());
        self.heap.push(8);
        self.heap.extend(value.as_bytes());
    }
    fn finish(mut self) -> Vec<u8> {
        for id in [TARGET_LOADER, TARGET_THREAD] {
            self.heap.push(0xff);
            self.heap.extend(id.to_be_bytes());
        }
        // Empty-array spacing independently rules out an 8-byte class pointer.
        self.array(0x1000, &[]);
        self.instance(0x1010, OBJECT, &[]);
        self.instance(0x1028, OBJECT, &[]);
        let heap = std::mem::take(&mut self.heap);
        self.record(0x1c, &heap);
        self.record(0x2c, &[]);
        self.out
    }
}

fn fixture(vendor: &str, with_root: bool, changed_thread: bool, foreign_loader: bool) -> Vec<u8> {
    let mut f = Fixture::new();
    f.class(OBJECT, "java/lang/Object", 0, 0, &[], &[]);
    let loader_fields = [
        ("parent", 2),
        ("name", 2),
        ("unnamedModule", 2),
        ("nameAndId", 2),
        ("parallelLockMap", 2),
        ("package2certs", 2),
        ("classes", 2),
        ("defaultDomain", 2),
        ("packages", 2),
        ("libraries", 2),
        ("assertionLock", 2),
        ("defaultAssertionStatus", 4),
        ("packageAssertionStatus", 2),
        ("classAssertionStatus", 2),
        ("classLoaderValueMap", 2),
    ];
    let mut thread_fields = vec![
        ("eetop", 11),
        ("tid", 11),
        ("name", 2),
        ("interrupted", 4),
        ("contextClassLoader", 2),
        ("inheritedAccessControlContext", 2),
        ("holder", 2),
        ("threadLocals", 2),
        ("inheritableThreadLocals", 2),
        ("scopedValueBindings", 2),
        ("interruptLock", 2),
        ("parkBlocker", 2),
        ("nioBlocker", 2),
        ("cont", 2),
        ("uncaughtExceptionHandler", 2),
        ("threadLocalRandomSeed", 11),
        ("threadLocalRandomProbe", 10),
        ("threadLocalRandomSecondarySeed", 10),
        ("container", 2),
        ("headStackableScopes", 2),
    ];
    if changed_thread {
        thread_fields.push(("unverifiedField", 4));
    }
    f.class(
        LOADER,
        "java/lang/ClassLoader",
        OBJECT,
        if foreign_loader { 0xdead } else { 0 },
        &loader_fields,
        &[],
    );
    f.class(THREAD, "java/lang/Thread", OBJECT, 0, &thread_fields, &[]);
    f.class(CHILD, "example/Loader", LOADER, 0xdead, &[], &[]);
    f.class(
        STRING,
        "java/lang/String",
        OBJECT,
        0,
        &[("value", 2), ("coder", 8)],
        &[],
    );
    f.class(
        SYSTEM,
        "java/lang/System",
        OBJECT,
        0,
        &[],
        &[("props", if with_root { 0xb000 } else { 0 })],
    );
    f.class(
        PROPERTIES,
        "java/util/Properties",
        OBJECT,
        0,
        &[("map", 2)],
        &[],
    );
    f.class(
        MAP,
        "java/util/concurrent/ConcurrentHashMap",
        OBJECT,
        0,
        &[("table", 2)],
        &[],
    );
    f.class(
        NODE,
        "java/util/concurrent/ConcurrentHashMap$Node",
        OBJECT,
        0,
        &[("hash", 10), ("key", 2), ("val", 2), ("next", 2)],
        &[],
    );
    f.class(ARRAY, "[Ljava/lang/Object;", OBJECT, 0, &[], &[]);
    // ClassDump loader IDs must refer to real objects, including in a disk
    // round-trip. A dangling loader makes this an invalid cache fixture.
    f.instance(0xdead, LOADER, &[0; 113]);
    f.instance(TARGET_LOADER, CHILD, &[0; 113]);
    f.instance(
        TARGET_THREAD,
        THREAD,
        &vec![0; 145 + usize::from(changed_thread)],
    );
    f.instance(0xb000, PROPERTIES, &0xb100u64.to_be_bytes());
    f.instance(0xb100, MAP, &0xb200u64.to_be_bytes());
    f.array(0xb200, &[0xb300, 0xb400, 0xb500]);
    for (i, (key, value)) in [
        ("java.vm.name", "OpenJDK 64-Bit Server VM"),
        ("java.vm.vendor", vendor),
        ("java.vm.version", "21.0.12.1"),
    ]
    .into_iter()
    .enumerate()
    {
        let key_id = 0xc000 + (i as u64) * 0x200;
        let value_id = key_id + 0x100;
        let mut body = 0u32.to_be_bytes().to_vec();
        for id in [key_id, value_id, 0] {
            body.extend(id.to_be_bytes());
        }
        f.instance(0xb300 + (i as u64) * 0x100, NODE, &body);
        f.string(key_id, key);
        f.string(value_id, value);
    }
    f.finish()
}

#[test]
fn matched_producer_adds_vm_fields_once_through_inheritance_in_both_backends() {
    let data = fixture("Homebrew", true, false, false);
    let indexed = parse_indexed(&data).unwrap();
    let (legacy, _) = build_graph(&data).unwrap();
    for (id, expected) in [(TARGET_LOADER, 136), (TARGET_THREAD, 176)] {
        assert_eq!(
            indexed.node_store.get_by_id(id).unwrap().shallow_size,
            expected
        );
        assert!(
            matches!(&legacy.graph()[legacy.id_to_node()[&id]], hprof_analyzer::NodeData::Instance { size,.. } if *size==expected)
        );
    }
    let model = indexed.summary.size_model.unwrap();
    assert_eq!(
        model.instance_layout_policy.as_deref(),
        Some("hotspot-homebrew-21.0.12.1-injected-v1")
    );
    assert_eq!(
        model.producer_detection.as_deref(),
        Some("system-properties-and-bootstrap-shapes")
    );
    assert!(model.estimated);
    assert_eq!(
        serde_json::to_value(model).unwrap(),
        serde_json::to_value(legacy.summary().size_model.as_ref().unwrap()).unwrap()
    );
}

#[test]
fn unknown_identity_decoy_strings_and_changed_bootstrap_shapes_do_not_select_a_profile() {
    for (vendor, root, changed, foreign) in [
        ("Unverified", true, false, false),
        ("Homebrew", false, false, false),
        ("Homebrew", true, true, false),
        ("Homebrew", true, false, true),
    ] {
        let parsed = parse_indexed(&fixture(vendor, root, changed, foreign)).unwrap();
        let model = parsed.summary.size_model.unwrap();
        assert_eq!(
            model.instance_layout_policy.as_deref(),
            Some("java-fields-only-v1")
        );
        assert!(model.estimated);
        assert_eq!(
            parsed
                .node_store
                .get_by_id(TARGET_LOADER)
                .unwrap()
                .shallow_size,
            128
        );
    }
}

#[test]
fn profiled_memory_disk_reopen_and_shallow_scan_agree_and_old_cache_is_untouched() {
    let data = fixture("Homebrew", true, false, false);
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let historical = root.path().join("structure-v6-preserved");
    std::fs::create_dir(&historical).unwrap();
    std::fs::write(historical.join("marker"), b"original").unwrap();
    let mut mmap = memmap2::MmapMut::map_anon(data.len()).unwrap();
    mmap.copy_from_slice(&data);
    let mapping = Arc::new(mmap.make_read_only().unwrap());
    let options = StorageOptions {
        mode: StorageMode::Disk,
        cache_dir: Some(root.path().into()),
        edge_buffer_bytes: 1024 * 1024,
    };
    let memory = parse_indexed(&data).unwrap();
    for expected_status in ["built", "reused"] {
        let (one, _, report) =
            load_structure(mapping.clone(), &options, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.cache_status, expected_status);
        assert_eq!(one.summary, memory.summary);
        assert_eq!(
            one.node_store
                .get_by_id(TARGET_LOADER)
                .unwrap()
                .shallow_size,
            136
        );
        assert_eq!(
            one.node_store
                .get_by_id(TARGET_THREAD)
                .unwrap()
                .shallow_size,
            176
        );
    }
    let shallow = hprof_analyzer::quick_scan::scan_shallow(&data).unwrap();
    assert_eq!(
        shallow.summary.total_heap_size,
        memory.summary.total_heap_size
    );
    assert_eq!(
        serde_json::to_value(shallow.summary.size_model).unwrap(),
        serde_json::to_value(memory.summary.size_model).unwrap()
    );
    assert_eq!(
        std::fs::read(historical.join("marker")).unwrap(),
        b"original"
    );
    assert!(std::fs::read_dir(root.path()).unwrap().any(|x| x
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("structure-v10-")));
}
