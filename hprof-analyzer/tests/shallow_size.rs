//! Parser-level byte fixtures: expected sizes are hand-counted, independent of
//! the production sizing policy. HPROF IDs are file values, not field widths.
use hprof_analyzer::indexed::parse::parse_indexed;
use hprof_analyzer::{build_graph, NodeData};

fn id(out: &mut Vec<u8>, value: u64, width: usize) {
    out.extend_from_slice(&value.to_be_bytes()[8 - width..]);
}
fn record(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
}
fn fixture(width: usize, count: u32, primitive: Option<u8>) -> Vec<u8> {
    let mut out = b"JAVA PROFILE 1.0.2\0".to_vec();
    out.extend_from_slice(&(width as u32).to_be_bytes());
    out.extend_from_slice(&0u64.to_be_bytes());
    let mut heap = vec![0xff];
    id(&mut heap, 0x1000, width);
    heap.push(if primitive.is_some() { 0x23 } else { 0x22 });
    id(&mut heap, 0x1000, width);
    heap.extend_from_slice(&0u32.to_be_bytes());
    heap.extend_from_slice(&count.to_be_bytes());
    let element_width = if let Some(kind) = primitive {
        heap.push(kind);
        match kind {
            4 | 8 => 1,
            5 | 9 => 2,
            6 | 10 => 4,
            7 | 11 => 8,
            _ => unreachable!(),
        }
    } else {
        id(&mut heap, 0x2000, width);
        width
    };
    heap.resize(heap.len() + count as usize * element_width, 0);
    record(&mut out, 0x1c, &heap);
    record(&mut out, 0x2c, &[]);
    out
}
#[test]
fn primitive_arrays_include_header_and_padding_in_both_backends() {
    for (kind, width) in [
        (4, 1),
        (5, 2),
        (6, 4),
        (7, 8),
        (8, 1),
        (9, 2),
        (10, 4),
        (11, 8),
    ] {
        for length in [0, 1, 2, 3, 7, 8, 9, 257] {
            // 32-bit model: 8-byte object header plus 4-byte array length.
            let header = if width == 8 { 16 } else { 12 };
            let expected = ((header + length as u64 * width + 7) / 8) * 8;
            let data = fixture(4, length, Some(kind));
            let indexed = parse_indexed(&data).unwrap();
            let (legacy, _) = build_graph(&data).unwrap();
            assert_eq!(
                indexed.node_store.get_by_id(0x1000).unwrap().shallow_size as u64,
                expected
            );
            match legacy.graph()[legacy.id_to_node()[&0x1000]] {
                NodeData::Array { size, .. } => assert_eq!(size as u64, expected),
                _ => panic!("missing array"),
            }
            assert_eq!(indexed.summary.total_heap_size, expected);
            assert_eq!(legacy.summary().total_heap_size, expected);
        }
    }
}
#[test]
fn empty_object_array_occupies_memory() {
    let data = fixture(4, 0, None);
    let indexed = parse_indexed(&data).unwrap();
    assert_eq!(
        indexed.node_store.get_by_id(0x1000).unwrap().shallow_size,
        16
    );
}

#[test]
fn node_storage_preserves_sizes_above_four_gib() {
    use hprof_analyzer::indexed::node_store::{NodeStore, NodeType};
    let size = 5 * 1024 * 1024 * 1024u64 + 24;
    let mut nodes = NodeStore::new();
    nodes.add_node(42, 0, size, NodeType::ObjectArray, "Object[]".into());
    assert_eq!(nodes.get_by_id(42).unwrap().shallow_size, size);
    let legacy = NodeData::Array {
        id: 42,
        size,
        class_name: "Object[]".into(),
    };
    assert!(matches!(legacy, NodeData::Array { size: stored, .. } if stored == size));
}
#[test]
fn truncated_array_returns_error_in_both_backends() {
    let data = fixture(8, 3, Some(11));
    let header = b"JAVA PROFILE 1.0.2\0".len() + 12;
    for missing in 1..=24 {
        let mut broken = data[..data.len() - 9 - missing].to_vec();
        let length = (broken.len() - header - 9) as u32;
        broken[header + 5..header + 9].copy_from_slice(&length.to_be_bytes());
        assert!(parse_indexed(&broken).is_err());
        assert!(build_graph(&broken).is_err());
    }
}

#[test]
fn explicit_layout_controls_both_backends_and_final_retained_sizes() {
    use hprof_analyzer::indexed::{
        analysis::IndexedAnalysisState, parse::parse_indexed_with_layout, types::HeapAnalysis,
    };
    for ref_width in [4, 8] {
        for class_width in [4, 8] {
            for alignment in [8, 16, 32] {
                let layout = hprof_analyzer::object_layout::ObjectLayout::new(
                    8,
                    ref_width,
                    class_width,
                    alignment,
                )
                .unwrap();
                for length in [0, 1, 3, 7, 257] {
                    let data = fixture(8, length, None);
                    let header = if class_width == 4 { 16 } else { 24 };
                    let mut expected = header + u64::from(length) * ref_width;
                    while expected % alignment != 0 {
                        expected += 1;
                    }
                    let parsed = parse_indexed_with_layout(&data, Some(layout)).unwrap();
                    assert_eq!(
                        parsed.node_store.get_by_id(0x1000).unwrap().shallow_size,
                        expected
                    );
                    let indexed = IndexedAnalysisState::from_parse_result(parsed).unwrap();
                    let (legacy, waste) =
                        hprof_analyzer::build_graph_with_layout(&data, Some(layout)).unwrap();
                    let legacy = hprof_analyzer::calculate_dominators_with_state(legacy, waste)
                        .unwrap()
                        .1;
                    assert_eq!(indexed.get_summary().reachable_heap_size, expected);
                    assert_eq!(legacy.summary.reachable_heap_size, expected);
                    assert_eq!(
                        indexed.get_object_info(0x1000).unwrap().0.retained_size,
                        expected
                    );
                    assert_eq!(
                        legacy.get_object_info(0x1000).unwrap().0.retained_size,
                        expected
                    );
                    let model = indexed.get_summary().size_model.as_ref().unwrap();
                    assert!(model.estimated);
                    assert_eq!(model.layout_source, "explicit");
                }
            }
        }
    }
}

#[test]
fn art_payload_behavior_is_preserved_while_android_work_is_parked() {
    let mut data = fixture(4, 3, Some(8));
    data[b"JAVA PROFILE 1.0.".len()] = b'3';
    let parsed = parse_indexed(&data).unwrap();
    assert_eq!(parsed.node_store.get_by_id(0x1000).unwrap().shallow_size, 3);
    assert_eq!(build_graph(&data).unwrap().0.summary().total_heap_size, 3);
    assert_eq!(parsed.summary.size_model.unwrap().name, "legacy-payload-v0");
}

fn class_record(heap: &mut Vec<u8>, class: u64, parent: u64, fields: &[u8]) {
    heap.push(0x20);
    id(heap, class, 8);
    heap.extend_from_slice(&0u32.to_be_bytes());
    id(heap, parent, 8);
    for _ in 0..5 {
        id(heap, 0, 8);
    }
    heap.extend_from_slice(&999u32.to_be_bytes()); // deliberately unreliable producer size
    heap.extend_from_slice(&[0, 0, 0, 0]); // constant pool, static fields
    heap.extend_from_slice(&(fields.len() as u16).to_be_bytes());
    for (i, kind) in fields.iter().enumerate() {
        id(heap, 100 + i as u64, 8);
        heap.push(*kind);
    }
}
#[test]
fn inherited_sizes_do_not_depend_on_record_order_or_serialized_id_width() {
    for classes_first in [false, true] {
        let mut out = b"JAVA PROFILE 1.0.2\0".to_vec();
        out.extend_from_slice(&8u32.to_be_bytes());
        out.extend_from_slice(&0u64.to_be_bytes());
        let mut classes = Vec::new();
        class_record(&mut classes, 0x100, 0, &[]);
        class_record(&mut classes, 0x110, 0x100, &[2]);
        class_record(&mut classes, 0x120, 0x110, &[8, 2]);
        let mut instance = vec![0xff];
        id(&mut instance, 0x1000, 8);
        instance.push(0x21);
        id(&mut instance, 0x1000, 8);
        instance.extend_from_slice(&0u32.to_be_bytes());
        id(&mut instance, 0x120, 8);
        instance.extend_from_slice(&17u32.to_be_bytes());
        instance.extend_from_slice(&[0; 17]); // byte + two serialized 8-byte IDs
        let body = if classes_first {
            [classes, instance].concat()
        } else {
            [instance, classes].concat()
        };
        record(&mut out, 0x1c, &body);
        let layout = hprof_analyzer::object_layout::ObjectLayout::new(8, 4, 4, 8).unwrap();
        let parsed =
            hprof_analyzer::indexed::parse::parse_indexed_with_layout(&out, Some(layout)).unwrap();
        let (legacy, _) = hprof_analyzer::build_graph_with_layout(&out, Some(layout)).unwrap();
        // 12-byte header + 1-byte primitive + two 4-byte references = 21 -> 24.
        assert_eq!(
            parsed.node_store.get_by_id(0x1000).unwrap().shallow_size,
            24
        );
        assert_eq!(legacy.summary().total_heap_size, 24);
    }
}
