//! Glue module combining all indexed data structures into a complete
//! analysis state that implements the `HeapAnalysis` trait.
//!
//! `IndexedAnalysisState` is the MAT-style counterpart of the original
//! `AnalysisState`, built from a `ParseResult` rather than a petgraph.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use petgraph::graph::NodeIndex;

use crate::heapql::{HeapQlError, QueryResult};
use crate::waste::{WasteAnalysis, WasteRawData};
use crate::{ClassHistogramEntry, FieldInfo, HeapSummary, LeakSuspect, ObjectReport};

use super::dominator::{compute_dominators, DominatorResult};
use super::node_store::{NodeStore, NodeType};
use super::edge_store::EdgeStore;
use super::class_index::ClassIndex;
use super::parse::ParseResult;
use super::string_table::StringTable;
use super::types::HeapAnalysis;
use super::waste::compute_indexed_waste;

/// Indexed analysis state implementing `HeapAnalysis`.
///
/// Combines the indexed data structures (NodeStore, EdgeStore, ClassIndex,
/// StringTable) with dominator results and derived analytics (histogram,
/// leak suspects, top objects). Waste analysis is computed lazily on first
/// access via `OnceLock`.
#[allow(dead_code)]
pub struct IndexedAnalysisState {
    node_store: NodeStore,
    edge_store: EdgeStore,
    class_index: ClassIndex,
    string_table: StringTable,
    dominator: DominatorResult,
    summary: HeapSummary,
    class_histogram: Vec<ClassHistogramEntry>,
    leak_suspects: Vec<LeakSuspect>,
    waste: OnceLock<WasteAnalysis>,
    waste_raw: WasteRawData,
    top_objects: Vec<ObjectReport>,
}

// Safety: WasteRawData fields are not Sync by default because of interior
// mutability concerns, but WasteRawData is only read (via &self) once
// stored. All fields are Send + Sync individually or behind OnceLock.
unsafe impl Send for IndexedAnalysisState {}
unsafe impl Sync for IndexedAnalysisState {}

impl IndexedAnalysisState {
    /// Builds an `IndexedAnalysisState` from a `ParseResult`.
    ///
    /// This performs:
    /// 1. Dominator tree computation on the CSR graph
    /// 2. Class histogram aggregation
    /// 3. Leak suspect identification (objects retaining >10% of heap)
    /// 4. Top-50 object selection by retained size
    pub fn from_parse_result(result: ParseResult) -> anyhow::Result<Self> {
        let ParseResult {
            node_store,
            edge_store,
            class_index,
            string_table,
            gc_root_ids,
            mut summary,
            waste_raw,
        } = result;

        // Collect GC root node indices
        let gc_root_indices: Vec<u32> = gc_root_ids
            .iter()
            .filter_map(|&id| node_store.index_of(id))
            .collect();

        // 1. Compute dominator tree
        let dominator = compute_dominators(&node_store, &edge_store, &gc_root_indices);

        // For now, set reachable = total (same as parse.rs does initially).
        // The dominator computation already handles unreachable nodes by
        // attaching them to root.
        summary.reachable_heap_size = summary.total_heap_size;

        // 2. Build class histogram
        let mut histogram_map: HashMap<String, (u64, u64, u64)> = HashMap::new();
        for i in 0..node_store.len() {
            let node = node_store.get_by_index(i as u32);
            match node.node_type {
                NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray => {
                    let class_name = node.class_name.to_string();
                    let shallow = node.shallow_size as u64;
                    let retained = dominator.retained_sizes[i];
                    let entry = histogram_map.entry(class_name).or_insert((0, 0, 0));
                    entry.0 += 1;
                    entry.1 += shallow;
                    entry.2 += retained;
                }
                _ => {}
            }
        }

        let mut class_histogram: Vec<ClassHistogramEntry> = histogram_map
            .into_iter()
            .map(|(class_name, (instance_count, shallow_size, retained_size))| {
                ClassHistogramEntry {
                    class_name,
                    instance_count,
                    shallow_size,
                    retained_size,
                }
            })
            .collect();
        class_histogram.sort_by(|a, b| b.retained_size.cmp(&a.retained_size));

        // 3. Identify leak suspects (objects retaining >10% of reachable heap)
        let reachable_heap_size = summary.reachable_heap_size;
        let mut leak_suspects = Vec::new();

        if reachable_heap_size > 0 {
            let threshold_pct = 10.0;
            let threshold_bytes = (reachable_heap_size as f64 * threshold_pct / 100.0) as u64;

            // Individual object suspects
            let mut candidates: Vec<(u32, u64, f64)> = Vec::new();
            for i in 0..node_store.len() {
                let node = node_store.get_by_index(i as u32);
                if !matches!(node.node_type, NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray) {
                    continue;
                }
                let retained = dominator.retained_sizes[i];
                if retained < threshold_bytes {
                    continue;
                }
                let percentage = (retained as f64 / reachable_heap_size as f64) * 100.0;
                candidates.push((i as u32, retained, percentage));
            }
            candidates.sort_by(|a, b| b.1.cmp(&a.1));

            for &(idx, retained, percentage) in candidates.iter().take(10) {
                let node = node_store.get_by_index(idx);
                let class_name = node.class_name.to_string();
                let display_name = if class_name.is_empty() {
                    "Unknown".to_string()
                } else {
                    class_name
                };
                leak_suspects.push(LeakSuspect {
                    class_name: display_name.clone(),
                    object_id: node.id,
                    retained_size: retained,
                    retained_percentage: percentage,
                    description: format!(
                        "Single {} instance retains {:.1}% of reachable heap ({:.2} MB)",
                        display_name,
                        percentage,
                        retained as f64 / (1024.0 * 1024.0)
                    ),
                });
            }

            // Class-level suspects
            for entry in &class_histogram {
                let percentage =
                    (entry.retained_size as f64 / reachable_heap_size as f64) * 100.0;
                if percentage > 10.0 && entry.instance_count > 1 {
                    let already_covered = leak_suspects
                        .iter()
                        .any(|s| s.class_name == entry.class_name);
                    if !already_covered {
                        leak_suspects.push(LeakSuspect {
                            class_name: entry.class_name.clone(),
                            object_id: 0,
                            retained_size: entry.retained_size,
                            retained_percentage: percentage,
                            description: format!(
                                "{} instances of {} collectively retain {:.1}% of reachable heap ({:.2} MB)",
                                entry.instance_count,
                                entry.class_name,
                                percentage,
                                entry.retained_size as f64 / (1024.0 * 1024.0)
                            ),
                        });
                    }
                }
            }

            leak_suspects.sort_by(|a, b| {
                b.retained_percentage
                    .partial_cmp(&a.retained_percentage)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        // 4. Select top 50 objects by retained size
        use std::collections::BinaryHeap;
        let mut top_heap: BinaryHeap<ObjectReport> = BinaryHeap::with_capacity(51);

        for i in 0..node_store.len() {
            let node = node_store.get_by_index(i as u32);
            let retained = dominator.retained_sizes[i];
            if retained == 0 {
                continue;
            }
            match node.node_type {
                NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray => {
                    let node_type_str = match node.node_type {
                        NodeType::Instance => "Instance",
                        NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
                        _ => unreachable!(),
                    };
                    let report = ObjectReport::new(
                        node.id,
                        node_type_str.to_string(),
                        node.class_name.to_string(),
                        node.shallow_size as u64,
                        retained,
                        NodeIndex::new(i),
                    );
                    top_heap.push(report);
                    if top_heap.len() > 50 {
                        top_heap.pop();
                    }
                }
                _ => {}
            }
        }

        let top_objects: Vec<ObjectReport> = top_heap.into_sorted_vec();

        Ok(Self {
            node_store,
            edge_store,
            class_index,
            string_table,
            dominator,
            summary,
            class_histogram,
            leak_suspects,
            waste: OnceLock::new(),
            waste_raw,
            top_objects,
        })
    }
}

impl HeapAnalysis for IndexedAnalysisState {
    fn get_children(&self, object_id: u64) -> Option<Vec<ObjectReport>> {
        let node_idx = if object_id == 0 {
            0u32
        } else {
            self.node_store.index_of(object_id)?
        };

        let children = &self.dominator.dominator_children[node_idx as usize];
        if children.is_empty() {
            return None;
        }

        let mut reports = Vec::new();
        for &child_idx in children {
            let node = self.node_store.get_by_index(child_idx);
            let retained = self.dominator.retained_sizes[child_idx as usize];

            // Filter out Class nodes and zero-retained-size nodes
            if matches!(node.node_type, NodeType::Class) || retained == 0 {
                continue;
            }

            let node_type_str = match node.node_type {
                NodeType::SuperRoot => "SuperRoot",
                NodeType::GcRoot => "Root",
                NodeType::Class => "Class",
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
            };

            let report = ObjectReport::new(
                node.id,
                node_type_str.to_string(),
                node.class_name.to_string(),
                node.shallow_size as u64,
                retained,
                NodeIndex::new(child_idx as usize),
            );
            reports.push(report);
        }

        if reports.is_empty() {
            return None;
        }

        reports.sort();
        Some(reports)
    }

    fn get_summary(&self) -> &HeapSummary {
        &self.summary
    }

    fn get_class_histogram(&self) -> &[ClassHistogramEntry] {
        &self.class_histogram
    }

    fn get_leak_suspects(&self) -> &[LeakSuspect] {
        &self.leak_suspects
    }

    fn get_waste_analysis(&self) -> &WasteAnalysis {
        self.waste.get_or_init(|| {
            compute_indexed_waste(&self.waste_raw, self.summary.total_heap_size)
        })
    }

    fn get_top_layers(&self, max_depth: usize, max_nodes: usize) -> Vec<ObjectReport> {
        let mut result = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::new();

        // Start from super-root (index 0)
        queue.push_back((0u32, 0usize));
        visited.insert(0u32);

        while let Some((node_idx, depth)) = queue.pop_front() {
            if depth >= max_depth || result.len() >= max_nodes {
                break;
            }

            let node = self.node_store.get_by_index(node_idx);
            let retained = self.dominator.retained_sizes[node_idx as usize];

            let node_type_str = match node.node_type {
                NodeType::SuperRoot => "SuperRoot",
                NodeType::GcRoot => "Root",
                NodeType::Class => "Class",
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
            };

            // Filter out Class nodes and zero-retained nodes (except SuperRoot)
            if matches!(node.node_type, NodeType::Class)
                || (retained == 0 && !matches!(node.node_type, NodeType::SuperRoot))
            {
                // Still explore children
                if depth + 1 < max_depth {
                    for &child in &self.dominator.dominator_children[node_idx as usize] {
                        if !visited.contains(&child) && result.len() < max_nodes {
                            visited.insert(child);
                            queue.push_back((child, depth + 1));
                        }
                    }
                }
                continue;
            }

            result.push(ObjectReport::new(
                node.id,
                node_type_str.to_string(),
                node.class_name.to_string(),
                node.shallow_size as u64,
                retained,
                NodeIndex::new(node_idx as usize),
            ));

            if depth + 1 < max_depth {
                for &child in &self.dominator.dominator_children[node_idx as usize] {
                    if !visited.contains(&child) && result.len() < max_nodes {
                        visited.insert(child);
                        queue.push_back((child, depth + 1));
                    }
                }
            }
        }

        result.sort();
        result
    }

    fn inspect_object(&self, _hprof_path: &Path, _object_id: u64) -> Option<Vec<FieldInfo>> {
        // TODO: Phase 4 — implement field inspection using ClassIndex field layouts
        // and re-reading the HPROF file for instance field bytes.
        None
    }

    fn inspect_object_bytes(&self, _hprof_bytes: &[u8], _object_id: u64) -> Option<Vec<FieldInfo>> {
        // TODO: Phase 4 — implement field inspection using ClassIndex field layouts
        None
    }

    fn execute_query(&self, _query_str: &str) -> Result<QueryResult, HeapQlError> {
        // TODO: Phase 4 — wire HeapQL to work with IndexedAnalysisState
        Err(HeapQlError::Execution(
            "HeapQL not yet supported on indexed backend".to_string(),
        ))
    }

    fn execute_query_paged(
        &self,
        _query_str: &str,
        _page: u64,
        _page_size: u64,
    ) -> Result<QueryResult, HeapQlError> {
        // TODO: Phase 4 — wire HeapQL to work with IndexedAnalysisState
        Err(HeapQlError::Execution(
            "HeapQL not yet supported on indexed backend".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::indexed::edge_store::EdgeBuilder;
    use crate::indexed::node_store::NodeStore;
    use crate::indexed::class_index::ClassIndex;
    use crate::indexed::string_table::StringTable;

    /// Helper: build a minimal ParseResult for testing.
    fn build_test_parse_result() -> ParseResult {
        let mut node_store = NodeStore::new();
        // Index 0: SuperRoot
        node_store.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        // Index 1: GC root / Instance
        node_store.add_node(100, 0, 64, NodeType::Instance, Arc::from("java.lang.Object"));
        // Index 2: Instance child
        node_store.add_node(200, 0, 128, NodeType::Instance, Arc::from("java.lang.String"));
        // Index 3: Array child
        node_store.add_node(300, 0, 256, NodeType::ObjectArray, Arc::from("byte[]"));

        let mut eb = EdgeBuilder::with_capacity(4);
        // SuperRoot -> GC root
        eb.add_edge(0, 1, 0);
        // Object -> String
        eb.add_edge(1, 2, 1);
        // String -> byte[]
        eb.add_edge(2, 3, 2);

        let edge_store = eb.build(4);

        ParseResult {
            node_store,
            edge_store,
            class_index: ClassIndex::new(),
            string_table: StringTable::new(),
            gc_root_ids: vec![100],
            summary: HeapSummary {
                total_heap_size: 448,
                reachable_heap_size: 448,
                total_instances: 2,
                total_classes: 0,
                total_arrays: 1,
                total_gc_roots: 1,
                hprof_version: "JAVA PROFILE 1.0.2".to_string(),
                heap_types: Vec::new(),
            },
            waste_raw: WasteRawData::new(),
        }
    }

    #[test]
    fn from_parse_result_builds_successfully() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        assert_eq!(state.summary.total_heap_size, 448);
        assert!(!state.class_histogram.is_empty());
        assert!(!state.top_objects.is_empty());
    }

    #[test]
    fn get_summary_returns_correct_data() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();
        let summary = state.get_summary();

        assert_eq!(summary.total_heap_size, 448);
        assert_eq!(summary.total_instances, 2);
        assert_eq!(summary.total_arrays, 1);
    }

    #[test]
    fn get_class_histogram_sorted_by_retained() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();
        let hist = state.get_class_histogram();

        assert!(!hist.is_empty());
        // Should be sorted descending by retained size
        for i in 1..hist.len() {
            assert!(hist[i - 1].retained_size >= hist[i].retained_size);
        }
    }

    #[test]
    fn get_children_of_super_root() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        let children = state.get_children(0);
        assert!(children.is_some());
        let children = children.unwrap();
        // SuperRoot's dominator children should include the GC root object
        assert!(!children.is_empty());
    }

    #[test]
    fn get_children_of_known_object() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        // Object 100 (java.lang.Object) should have child 200 (java.lang.String)
        let children = state.get_children(100);
        assert!(children.is_some());
        let children = children.unwrap();
        assert!(children.iter().any(|c| c.object_id == 200));
    }

    #[test]
    fn get_children_of_unknown_object_returns_none() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        assert!(state.get_children(99999).is_none());
    }

    #[test]
    fn get_children_of_leaf_returns_none() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        // byte[] (300) is a leaf — no children
        assert!(state.get_children(300).is_none());
    }

    #[test]
    fn get_waste_analysis_lazy() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        // Waste should be computed on first access
        let waste = state.get_waste_analysis();
        assert_eq!(waste.total_wasted_bytes, 0); // no waste data in test
    }

    #[test]
    fn get_top_layers_returns_results() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        let layers = state.get_top_layers(3, 100);
        assert!(!layers.is_empty());
    }

    #[test]
    fn get_top_layers_respects_depth_limit() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        let layers_shallow = state.get_top_layers(1, 100);
        let layers_deep = state.get_top_layers(5, 100);
        // Deeper traversal should produce at least as many results
        assert!(layers_deep.len() >= layers_shallow.len());
    }

    #[test]
    fn execute_query_returns_error() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        let result = state.execute_query("SELECT * FROM class_histogram");
        assert!(result.is_err());
    }

    #[test]
    fn inspect_object_returns_none() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        assert!(state.inspect_object(Path::new("/tmp/test.hprof"), 100).is_none());
        assert!(state.inspect_object_bytes(&[], 100).is_none());
    }

    #[test]
    fn retained_sizes_are_consistent() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        // byte[] (idx 3) retained = 256 (shallow only, leaf)
        let byte_arr_idx = state.node_store.index_of(300).unwrap() as usize;
        assert_eq!(state.dominator.retained_sizes[byte_arr_idx], 256);

        // String (idx 2) retained = 128 + 256 = 384
        let string_idx = state.node_store.index_of(200).unwrap() as usize;
        assert_eq!(state.dominator.retained_sizes[string_idx], 384);

        // Object (idx 1) retained = 64 + 384 = 448
        let obj_idx = state.node_store.index_of(100).unwrap() as usize;
        assert_eq!(state.dominator.retained_sizes[obj_idx], 448);
    }

    #[test]
    fn leak_suspects_detected_for_large_retainers() {
        // Build a graph where one object retains >10% of heap
        let mut node_store = NodeStore::new();
        node_store.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        node_store.add_node(1, 0, 100, NodeType::Instance, Arc::from("small.A"));
        node_store.add_node(2, 0, 900, NodeType::Instance, Arc::from("big.B"));

        let mut eb = EdgeBuilder::with_capacity(3);
        eb.add_edge(0, 1, 0);
        eb.add_edge(0, 2, 0);
        let edge_store = eb.build(3);

        let pr = ParseResult {
            node_store,
            edge_store,
            class_index: ClassIndex::new(),
            string_table: StringTable::new(),
            gc_root_ids: vec![1, 2],
            summary: HeapSummary {
                total_heap_size: 1000,
                reachable_heap_size: 1000,
                total_instances: 2,
                total_classes: 0,
                total_arrays: 0,
                total_gc_roots: 2,
                hprof_version: String::new(),
                heap_types: Vec::new(),
            },
            waste_raw: WasteRawData::new(),
        };

        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();
        // big.B retains 90% of heap, should be a suspect
        assert!(!state.leak_suspects.is_empty());
        assert!(state.leak_suspects.iter().any(|s| s.class_name == "big.B"));
    }
}
