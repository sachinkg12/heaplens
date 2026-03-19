//! Shared test helpers for building synthetic AnalysisState instances.
//! Used by both unit tests in heapql.rs and integration tests in tests/.

use crate::{AnalysisState, ClassHistogramEntry, EdgeLabel, LeakSuspect, HeapSummary, WasteAnalysis};
use petgraph::graph::NodeIndex;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// Build a synthetic AnalysisState for testing (no .hprof needed).
/// Contains 4 instances: HashMap, ArrayList, byte[], CacheManager.
pub fn build_test_state() -> AnalysisState {
    let mut node_data_map: Vec<(u64, &'static str, Arc<str>)> = Vec::new();
    node_data_map.push((0, "SuperRoot", Arc::from("")));
    node_data_map.push((0, "Root", Arc::from("")));
    node_data_map.push((100, "Instance", Arc::from("java.util.HashMap")));
    node_data_map.push((200, "Instance", Arc::from("java.util.ArrayList")));
    node_data_map.push((300, "Array", Arc::from("byte[]")));
    node_data_map.push((400, "Instance", Arc::from("com.app.CacheManager")));

    let shallow_sizes = vec![0, 0, 48, 40, 1024, 32];
    let retained_sizes = vec![0, 0, 2048, 1024, 1024, 4096];

    let mut id_to_node = HashMap::new();
    id_to_node.insert(100, NodeIndex::new(2));
    id_to_node.insert(200, NodeIndex::new(3));
    id_to_node.insert(300, NodeIndex::new(4));
    id_to_node.insert(400, NodeIndex::new(5));

    let mut children_map: HashMap<NodeIndex, Vec<NodeIndex>> = HashMap::new();
    children_map.insert(NodeIndex::new(0), vec![NodeIndex::new(1)]);
    children_map.insert(NodeIndex::new(1), vec![NodeIndex::new(2), NodeIndex::new(5)]);
    children_map.insert(NodeIndex::new(2), vec![NodeIndex::new(3)]);
    children_map.insert(NodeIndex::new(3), vec![NodeIndex::new(4)]);

    // Forward edges: (source, target, label) — reverse_refs built lazily
    let forward_edges: Vec<(u32, u32, EdgeLabel)> = vec![
        (1, 2, EdgeLabel::Unknown),
        (2, 3, EdgeLabel::Unknown),
        (3, 4, EdgeLabel::Unknown),
        (1, 5, EdgeLabel::Unknown),
    ];

    let class_histogram = vec![
        ClassHistogramEntry {
            class_name: "com.app.CacheManager".into(),
            instance_count: 1,
            shallow_size: 32,
            retained_size: 4096,
        },
        ClassHistogramEntry {
            class_name: "java.util.HashMap".into(),
            instance_count: 5,
            shallow_size: 240,
            retained_size: 2048,
        },
        ClassHistogramEntry {
            class_name: "byte[]".into(),
            instance_count: 10,
            shallow_size: 10240,
            retained_size: 1024,
        },
    ];

    let leak_suspects = vec![
        LeakSuspect {
            class_name: "com.app.CacheManager".into(),
            object_id: 400,
            retained_size: 4096,
            retained_percentage: 50.0,
            description: "Retains 50% of heap".into(),
        },
    ];

    let summary = HeapSummary {
        total_heap_size: 8192,
        reachable_heap_size: 8192,
        total_instances: 4,
        total_classes: 3,
        total_arrays: 1,
        total_gc_roots: 1,
        hprof_version: String::new(),
        heap_types: Vec::new(),
    };

    AnalysisState {
        children_map,
        retained_sizes,
        shallow_sizes,
        id_to_node,
        super_root: NodeIndex::new(0),
        node_data_map,
        class_histogram,
        leak_suspects,
        summary,
        forward_edges,
        reverse_refs: OnceLock::new(),
        waste_analysis: WasteAnalysis {
            total_wasted_bytes: 0,
            waste_percentage: 0.0,
            duplicate_string_wasted_bytes: 0,
            empty_collection_wasted_bytes: 0,
            over_allocated_wasted_bytes: 0,
            boxed_primitive_wasted_bytes: 0,
            duplicate_strings: vec![],
            empty_collections: vec![],
            over_allocated_collections: vec![],
            boxed_primitives: vec![],
        },
        field_name_table: vec![],
        class_field_layouts: std::collections::HashMap::new(),
        id_size: jvm_hprof::IdSize::U64,
    }
}

/// Build a second synthetic AnalysisState for compare_heaps testing.
/// Differs from the first: CacheManager has grown, ArrayList removed, new "SessionStore" added.
pub fn build_second_test_state() -> AnalysisState {
    let mut node_data_map: Vec<(u64, &'static str, Arc<str>)> = Vec::new();
    node_data_map.push((0, "SuperRoot", Arc::from("")));
    node_data_map.push((0, "Root", Arc::from("")));
    node_data_map.push((100, "Instance", Arc::from("java.util.HashMap")));
    node_data_map.push((300, "Array", Arc::from("byte[]")));
    node_data_map.push((400, "Instance", Arc::from("com.app.CacheManager")));
    node_data_map.push((500, "Instance", Arc::from("com.app.SessionStore")));

    let shallow_sizes = vec![0, 0, 48, 2048, 64, 128];
    let retained_sizes = vec![0, 0, 2048, 2048, 8192, 4096];

    let mut id_to_node = HashMap::new();
    id_to_node.insert(100, NodeIndex::new(2));
    id_to_node.insert(300, NodeIndex::new(3));
    id_to_node.insert(400, NodeIndex::new(4));
    id_to_node.insert(500, NodeIndex::new(5));

    let mut children_map: HashMap<NodeIndex, Vec<NodeIndex>> = HashMap::new();
    children_map.insert(NodeIndex::new(0), vec![NodeIndex::new(1)]);
    children_map.insert(NodeIndex::new(1), vec![NodeIndex::new(2), NodeIndex::new(4), NodeIndex::new(5)]);
    children_map.insert(NodeIndex::new(2), vec![NodeIndex::new(3)]);

    let forward_edges: Vec<(u32, u32, EdgeLabel)> = vec![
        (1, 2, EdgeLabel::Unknown),
        (2, 3, EdgeLabel::Unknown),
        (1, 4, EdgeLabel::Unknown),
        (1, 5, EdgeLabel::Unknown),
    ];

    let class_histogram = vec![
        ClassHistogramEntry {
            class_name: "com.app.CacheManager".into(),
            instance_count: 2,
            shallow_size: 64,
            retained_size: 8192,
        },
        ClassHistogramEntry {
            class_name: "java.util.HashMap".into(),
            instance_count: 5,
            shallow_size: 240,
            retained_size: 2048,
        },
        ClassHistogramEntry {
            class_name: "byte[]".into(),
            instance_count: 20,
            shallow_size: 20480,
            retained_size: 2048,
        },
        ClassHistogramEntry {
            class_name: "com.app.SessionStore".into(),
            instance_count: 1,
            shallow_size: 128,
            retained_size: 4096,
        },
    ];

    let leak_suspects = vec![
        LeakSuspect {
            class_name: "com.app.CacheManager".into(),
            object_id: 400,
            retained_size: 8192,
            retained_percentage: 50.0,
            description: "Retains 50% of heap".into(),
        },
        LeakSuspect {
            class_name: "com.app.SessionStore".into(),
            object_id: 500,
            retained_size: 4096,
            retained_percentage: 25.0,
            description: "Retains 25% of heap".into(),
        },
    ];

    let summary = HeapSummary {
        total_heap_size: 16384,
        reachable_heap_size: 16384,
        total_instances: 4,
        total_classes: 4,
        total_arrays: 1,
        total_gc_roots: 1,
        hprof_version: String::new(),
        heap_types: Vec::new(),
    };

    AnalysisState {
        children_map,
        retained_sizes,
        shallow_sizes,
        id_to_node,
        super_root: NodeIndex::new(0),
        node_data_map,
        class_histogram,
        leak_suspects,
        summary,
        forward_edges,
        reverse_refs: OnceLock::new(),
        waste_analysis: WasteAnalysis {
            total_wasted_bytes: 0,
            waste_percentage: 0.0,
            duplicate_string_wasted_bytes: 0,
            empty_collection_wasted_bytes: 0,
            over_allocated_wasted_bytes: 0,
            boxed_primitive_wasted_bytes: 0,
            duplicate_strings: vec![],
            empty_collections: vec![],
            over_allocated_collections: vec![],
            boxed_primitives: vec![],
        },
        field_name_table: vec![],
        class_field_layouts: std::collections::HashMap::new(),
        id_size: jvm_hprof::IdSize::U64,
    }
}
