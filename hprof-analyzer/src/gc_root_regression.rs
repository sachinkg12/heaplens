//! Regression fixtures for standard HPROF root kinds that carry an object ID
//! and thread serial number.

const CLASS_ID: u32 = 0x100;
const NATIVE_STACK_OBJECT_ID: u32 = 0x200;
const THREAD_BLOCK_OBJECT_ID: u32 = 0x201;

fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn push_id(bytes: &mut Vec<u8>, value: u32, id_size: usize) {
    match id_size {
        4 => push_u32(bytes, value),
        8 => bytes.extend_from_slice(&(value as u64).to_be_bytes()),
        _ => panic!("unsupported test ID size"),
    }
}

fn push_record(hprof: &mut Vec<u8>, tag: u8, body: &[u8]) {
    hprof.push(tag);
    push_u32(hprof, 0);
    push_u32(hprof, body.len() as u32);
    hprof.extend_from_slice(body);
}

fn push_utf8_record(hprof: &mut Vec<u8>, id: u32, text: &str, id_size: usize) {
    let mut body = Vec::new();
    push_id(&mut body, id, id_size);
    body.extend_from_slice(text.as_bytes());
    push_record(hprof, 0x01, &body);
}

fn push_load_class_record(
    hprof: &mut Vec<u8>,
    serial: u32,
    class_id: u32,
    name_id: u32,
    id_size: usize,
) {
    let mut body = Vec::new();
    push_u32(&mut body, serial);
    push_id(&mut body, class_id, id_size);
    push_u32(&mut body, 0);
    push_id(&mut body, name_id, id_size);
    push_record(hprof, 0x02, &body);
}

fn push_class_dump(heap: &mut Vec<u8>, class_id: u32, id_size: usize) {
    heap.push(0x20);
    push_id(heap, class_id, id_size);
    push_u32(heap, 0);
    for _ in 0..6 {
        push_id(heap, 0, id_size);
    }
    push_u32(heap, 16);
    push_u16(heap, 0);
    push_u16(heap, 0);
    push_u16(heap, 0);
}

fn push_thread_root(
    heap: &mut Vec<u8>,
    tag: u8,
    object_id: u32,
    thread_serial: u32,
    id_size: usize,
) {
    heap.push(tag);
    push_id(heap, object_id, id_size);
    push_u32(heap, thread_serial);
}

fn push_instance_dump(heap: &mut Vec<u8>, object_id: u32, class_id: u32, id_size: usize) {
    heap.push(0x21);
    push_id(heap, object_id, id_size);
    push_u32(heap, 0);
    push_id(heap, class_id, id_size);
    push_u32(heap, 0);
}

/// Independent minimal HPROF oracle:
/// - tag 0x04 is ROOT_NATIVE_STACK
/// - tag 0x06 is ROOT_THREAD_BLOCK
/// Each root is the sole path from the synthetic super-root to its instance.
fn thread_owned_roots_hprof(
    id_size: usize,
    native_stack_object_id: u32,
    thread_block_object_id: u32,
    thread_serial: u32,
) -> Vec<u8> {
    let mut hprof = b"JAVA PROFILE 1.0.2\0".to_vec();
    push_u32(&mut hprof, id_size as u32);
    hprof.extend_from_slice(&0u64.to_be_bytes());

    push_utf8_record(&mut hprof, 1, "example/ThreadOwned", id_size);
    push_load_class_record(&mut hprof, 1, CLASS_ID, 1, id_size);

    let mut heap = Vec::new();
    push_class_dump(&mut heap, CLASS_ID, id_size);
    push_thread_root(
        &mut heap,
        0x04,
        native_stack_object_id,
        thread_serial,
        id_size,
    );
    push_thread_root(
        &mut heap,
        0x06,
        thread_block_object_id,
        thread_serial,
        id_size,
    );
    push_instance_dump(&mut heap, native_stack_object_id, CLASS_ID, id_size);
    push_instance_dump(&mut heap, thread_block_object_id, CLASS_ID, id_size);

    push_record(&mut hprof, 0x1c, &heap);
    push_record(&mut hprof, 0x2c, &[]);
    hprof
}

#[test]
fn legacy_connects_native_stack_and_thread_block_roots() {
    for id_size in [4, 8] {
        let hprof =
            thread_owned_roots_hprof(id_size, NATIVE_STACK_OBJECT_ID, THREAD_BLOCK_OBJECT_ID, 7);
        let (graph, _) = crate::build_graph(&hprof).unwrap();
        let native_stack = graph.id_to_node()[&(NATIVE_STACK_OBJECT_ID as u64)];
        let thread_block = graph.id_to_node()[&(THREAD_BLOCK_OBJECT_ID as u64)];

        assert_eq!(graph.summary().total_gc_roots, 2);
        assert!(graph
            .graph()
            .find_edge(graph.super_root(), native_stack)
            .is_some());
        assert!(graph
            .graph()
            .find_edge(graph.super_root(), thread_block)
            .is_some());
    }
}

#[test]
fn indexed_connects_native_stack_and_thread_block_roots() {
    for id_size in [4, 8] {
        let hprof =
            thread_owned_roots_hprof(id_size, NATIVE_STACK_OBJECT_ID, THREAD_BLOCK_OBJECT_ID, 7);
        let parsed = crate::indexed::parse::parse_indexed(&hprof).unwrap();
        let native_stack = parsed
            .node_store
            .index_of(NATIVE_STACK_OBJECT_ID as u64)
            .unwrap();
        let thread_block = parsed
            .node_store
            .index_of(THREAD_BLOCK_OBJECT_ID as u64)
            .unwrap();

        assert_eq!(parsed.summary.total_gc_roots, 2);
        assert!(parsed.edge_store.neighbors(0).contains(&native_stack));
        assert!(parsed.edge_store.neighbors(0).contains(&thread_block));
    }
}

#[test]
fn generated_root_ids_match_simple_backend_oracle() {
    let mut seed = 0x5eed_u32;
    for case in 0..32 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let native_stack_object_id = 0x1_0000 | (seed & 0x0fff_fffc);
        let thread_block_object_id = native_stack_object_id + 1;
        let thread_serial = case + 1;

        for id_size in [4, 8] {
            let hprof = thread_owned_roots_hprof(
                id_size,
                native_stack_object_id,
                thread_block_object_id,
                thread_serial,
            );

            let (legacy, _) = crate::build_graph(&hprof).unwrap();
            let indexed = crate::indexed::parse::parse_indexed(&hprof).unwrap();

            assert_eq!(legacy.summary().total_gc_roots, 2);
            assert_eq!(indexed.summary.total_gc_roots, 2);
            for object_id in [native_stack_object_id, thread_block_object_id] {
                let legacy_node = legacy.id_to_node()[&(object_id as u64)];
                let indexed_node = indexed.node_store.index_of(object_id as u64).unwrap();
                assert!(legacy
                    .graph()
                    .find_edge(legacy.super_root(), legacy_node)
                    .is_some());
                assert!(indexed.edge_store.neighbors(0).contains(&indexed_node));
            }
        }
    }
}

#[test]
fn truncated_thread_owned_roots_return_errors_without_panicking() {
    for root_tag in [0x04, 0x06] {
        let mut hprof = b"JAVA PROFILE 1.0.2\0".to_vec();
        push_u32(&mut hprof, 4);
        hprof.extend_from_slice(&0u64.to_be_bytes());

        let mut incomplete_root = vec![root_tag];
        push_u32(&mut incomplete_root, NATIVE_STACK_OBJECT_ID);
        push_record(&mut hprof, 0x1c, &incomplete_root);

        assert!(crate::build_graph(&hprof).is_err());
        assert!(crate::indexed::parse::parse_indexed(&hprof).is_err());
    }
}
