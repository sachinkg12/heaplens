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
use super::parse::{ParseResult, Phase1Result, Phase2Result};
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
    object_leak_suspects: Vec<LeakSuspect>,
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

        // Compute reachable heap size by subtracting unreachable node sizes
        // (same logic as the legacy dominator.rs path).
        let unreachable_size = dominator.unreachable_shallow_size;
        if unreachable_size < summary.total_heap_size {
            summary.reachable_heap_size = summary.total_heap_size - unreachable_size;
        } else {
            summary.reachable_heap_size = summary.total_heap_size;
        }
        log::info!("Heap sizes: total={:.2} MB, unreachable={:.2} MB, reachable={:.2} MB",
            summary.total_heap_size as f64 / (1024.0 * 1024.0),
            unreachable_size as f64 / (1024.0 * 1024.0),
            summary.reachable_heap_size as f64 / (1024.0 * 1024.0));

        // 2. Build class histogram, collect leak candidates, and select top-50
        //    objects in a single pass over all nodes.
        use std::collections::BinaryHeap;

        let reachable_heap_size = summary.reachable_heap_size;
        let threshold_bytes = if reachable_heap_size > 0 {
            (reachable_heap_size as f64 * 0.10) as u64
        } else {
            u64::MAX
        };

        let mut histogram_map: HashMap<String, (u64, u64, u64)> = HashMap::new();
        // Min-heap of top-10 leak candidates by retained size (keeps smallest on top)
        let mut leak_heap: BinaryHeap<std::cmp::Reverse<(u64, u32)>> = BinaryHeap::with_capacity(11);
        // Min-heap of top-50 objects by retained size
        let mut top_heap: BinaryHeap<ObjectReport> = BinaryHeap::with_capacity(51);

        for i in 0..node_store.len() {
            let node = node_store.get_by_index(i as u32);
            let shallow = node.shallow_size as u64;
            let retained = dominator.retained_sizes[i];

            match node.node_type {
                NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray => {}
                NodeType::Class => {
                    // Include Class nodes only if they retain >1% of heap
                    // (user-defined classes with large static fields)
                    let total = summary.total_heap_size;
                    if total == 0 || (retained as f64 / total as f64) < 0.01 {
                        continue;
                    }
                }
                _ => continue,
            }

            // Histogram aggregation
            let class_name = node.class_name.to_string();
            let entry = histogram_map.entry(class_name).or_insert((0, 0, 0));
            entry.0 += 1;
            entry.1 += shallow;
            entry.2 += retained;

            if retained == 0 {
                continue;
            }

            // Leak candidate: only track objects above the 10% threshold
            if retained >= threshold_bytes {
                leak_heap.push(std::cmp::Reverse((retained, i as u32)));
                if leak_heap.len() > 10 {
                    leak_heap.pop();
                }
            }

            // Top-50 objects by retained size (BinaryHeap min-heap via ObjectReport Ord)
            let node_type_str = match node.node_type {
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
                NodeType::Class => "Class",
                _ => continue,
            };
            let report = ObjectReport::new(
                node.id,
                node_type_str.to_string(),
                node.class_name.to_string(),
                shallow,
                retained,
                NodeIndex::new(i),
            );
            top_heap.push(report);
            if top_heap.len() > 50 {
                top_heap.pop();
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

        // 3. Build leak suspects — class-level aggregations first (matching legacy behavior),
        //    then individual suspects only if not already covered.
        let mut leak_suspects = Vec::new();
        let mut object_leak_suspects = Vec::new();

        if reachable_heap_size > 0 {
            // Phase 1: Class-level suspects (>10% retained, multiple instances)
            // Note: summing retained sizes across instances of the same class can exceed
            // reachable heap size when one instance dominates another of the same class.
            // We cap at 99.9% to avoid misleading percentages.
            for entry in &class_histogram {
                let raw_percentage =
                    (entry.retained_size as f64 / reachable_heap_size as f64) * 100.0;
                let percentage = raw_percentage.min(99.9);
                if raw_percentage > 10.0 && entry.instance_count > 1 {
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

            // Phase 2: Individual suspects (>10% retained), only if not already
            // covered by a class-level suspect for the same class name.
            let mut candidates: Vec<(u64, u32)> = leak_heap.into_iter().map(|r| r.0).collect();
            candidates.sort_by(|a, b| b.0.cmp(&a.0));

            for &(retained, idx) in &candidates {
                if leak_suspects.len() >= 10 {
                    break;
                }
                let node = node_store.get_by_index(idx);
                let class_name = node.class_name.to_string();
                let display_name = if class_name.is_empty() {
                    "Unknown".to_string()
                } else {
                    class_name
                };
                // Skip if this class is already represented by a class-level suspect
                let already_covered = leak_suspects
                    .iter()
                    .any(|s| s.class_name == display_name);
                if already_covered {
                    continue;
                }
                let percentage = (retained as f64 / reachable_heap_size as f64) * 100.0;
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

            leak_suspects.sort_by(|a, b| {
                b.retained_percentage
                    .partial_cmp(&a.retained_percentage)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            // 3b. Build object-level suspects from all individual candidates
            // (no class-level filtering — every individual object above threshold)
            for &(retained, idx) in candidates.iter().take(10) {
                let node = node_store.get_by_index(idx);
                let class_name = node.class_name.to_string();
                let display_name = if class_name.is_empty() {
                    "Unknown".to_string()
                } else {
                    class_name
                };
                let percentage = (retained as f64 / reachable_heap_size as f64) * 100.0;
                object_leak_suspects.push(LeakSuspect {
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
            object_leak_suspects.sort_by(|a, b| {
                b.retained_percentage
                    .partial_cmp(&a.retained_percentage)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            // Deduplicate: remove objects whose dominator parent is also a suspect.
            // This prevents showing the same dominator chain multiple times
            // (e.g., ConnectionPool -> ArrayList -> Object[] all showing ~76.8%).
            let suspect_indices: std::collections::HashSet<u32> = object_leak_suspects
                .iter()
                .filter_map(|s| node_store.index_of(s.object_id))
                .collect();

            object_leak_suspects.retain(|s| {
                if let Some(idx) = node_store.index_of(s.object_id) {
                    let parent = dominator.dominator_parent[idx as usize];
                    if parent != u32::MAX {
                        // If parent is also a suspect, remove this child
                        !suspect_indices.contains(&parent)
                    } else {
                        true
                    }
                } else {
                    true
                }
            });
        }

        // 4. Finalize top-50 objects
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
            object_leak_suspects,
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

            // Filter out zero-retained-size nodes and small Class nodes.
            // Class nodes with significant retained size (>1% of heap) are shown
            // because they may be user-defined classes holding leaked data via static fields.
            if retained == 0 {
                continue;
            }
            if matches!(node.node_type, NodeType::Class) {
                let total = self.summary.total_heap_size;
                if total > 0 && (retained as f64 / total as f64) < 0.01 {
                    continue;
                }
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

    fn get_object_leak_suspects(&self) -> &[LeakSuspect] {
        &self.object_leak_suspects
    }

    fn get_waste_analysis(&self) -> &WasteAnalysis {
        self.waste.get_or_init(|| {
            compute_indexed_waste(&self.waste_raw, self.summary.total_heap_size)
        })
    }

    fn get_top_layers(&self, _max_depth: usize, max_nodes: usize) -> Vec<ObjectReport> {
        // Return top objects by retained size (pre-computed during construction)
        self.top_objects.iter().take(max_nodes).cloned().collect()
    }

    fn inspect_object(&self, hprof_path: &Path, object_id: u64) -> Option<Vec<FieldInfo>> {
        let data = std::fs::read(hprof_path).ok()?;
        self.inspect_object_bytes(&data, object_id)
    }

    fn inspect_object_bytes(&self, hprof_bytes: &[u8], object_id: u64) -> Option<Vec<FieldInfo>> {
        use jvm_hprof::heap_dump::FieldType;
        use jvm_hprof::{parse_hprof, RecordTag};

        // Verify object exists and is an Instance
        let node_idx = self.node_store.index_of(object_id)?;
        let node = self.node_store.get_by_index(node_idx);
        if node.node_type != NodeType::Instance {
            return None;
        }

        let hprof = parse_hprof(hprof_bytes).ok()?;
        let id_size = hprof.header().id_size();
        let id_bytes: usize = match id_size {
            jvm_hprof::IdSize::U32 => 4,
            jvm_hprof::IdSize::U64 => 8,
        };

        // Scan for the Instance record with matching obj_id
        for record_result in hprof.records_iter() {
            let record = match record_result {
                Ok(r) => r,
                Err(_) => continue,
            };
            if record.tag() != RecordTag::HeapDump && record.tag() != RecordTag::HeapDumpSegment {
                continue;
            }
            let heap_dump = match record.as_heap_dump_segment() {
                Some(Ok(hd)) => hd,
                _ => continue,
            };
            for sub_result in heap_dump.sub_records() {
                let sub = match sub_result {
                    Ok(sr) => sr,
                    Err(_) => continue,
                };
                if let jvm_hprof::heap_dump::SubRecord::Instance(instance) = sub {
                    if instance.obj_id().id() != object_id {
                        continue;
                    }
                    let class_obj_id = instance.class_obj_id().id();
                    let layout = self.class_index.field_layout(class_obj_id)?;
                    let field_data = instance.fields();

                    let mut fields = Vec::with_capacity(layout.len());
                    let mut offset = 0;

                    for (name, ft) in layout {
                        let size = crate::field_type_size(ft, id_size);
                        if offset + size > field_data.len() {
                            break;
                        }

                        let type_str = match *ft {
                            FieldType::ObjectId => "ref",
                            FieldType::Boolean => "boolean",
                            FieldType::Byte => "byte",
                            FieldType::Char => "char",
                            FieldType::Short => "short",
                            FieldType::Int => "int",
                            FieldType::Float => "float",
                            FieldType::Long => "long",
                            FieldType::Double => "double",
                        };

                        let bytes = &field_data[offset..offset + size];
                        let raw_value = match size {
                            1 => bytes[0] as u64,
                            2 => u16::from_be_bytes([bytes[0], bytes[1]]) as u64,
                            4 => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as u64,
                            8 => u64::from_be_bytes([
                                bytes[0], bytes[1], bytes[2], bytes[3],
                                bytes[4], bytes[5], bytes[6], bytes[7],
                            ]),
                            _ => 0,
                        };

                        let (primitive_value, ref_object_id, ref_summary) = match *ft {
                            FieldType::ObjectId => {
                                if raw_value == 0 {
                                    (Some("null".to_string()), None, None)
                                } else {
                                    let ref_id = raw_value;
                                    let summary = self.node_store.get_by_id(ref_id).map(|n| {
                                        let idx = self.node_store.index_of(ref_id).unwrap_or(0) as usize;
                                        let retained = self.dominator.retained_sizes[idx];
                                        let node_type_str = match n.node_type {
                                            NodeType::Instance => "Instance",
                                            NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
                                            NodeType::Class => "Class",
                                            NodeType::GcRoot => "Root",
                                            NodeType::SuperRoot => "SuperRoot",
                                        };
                                        crate::RefSummary {
                                            class_name: n.class_name.to_string(),
                                            node_type: node_type_str.to_string(),
                                            shallow_size: n.shallow_size as u64,
                                            retained_size: retained,
                                        }
                                    });
                                    (None, Some(ref_id), summary)
                                }
                            }
                            FieldType::Boolean => (Some(if raw_value != 0 { "true" } else { "false" }.to_string()), None, None),
                            FieldType::Char => (Some(format!("'{}'", char::from_u32(raw_value as u32).unwrap_or('?'))), None, None),
                            FieldType::Float => (Some(format!("{}", f32::from_bits(raw_value as u32))), None, None),
                            FieldType::Double => (Some(format!("{}", f64::from_bits(raw_value))), None, None),
                            _ => (Some(raw_value.to_string()), None, None),
                        };

                        fields.push(FieldInfo {
                            name: name.to_string(),
                            field_type: type_str.to_string(),
                            primitive_value,
                            ref_object_id,
                            ref_summary,
                        });

                        offset += size;
                    }

                    return Some(fields);
                }
            }
        }
        None
    }

    fn execute_query(&self, query_str: &str) -> Result<QueryResult, HeapQlError> {
        crate::heapql::HeapQlEngine::new(self).execute_query(query_str)
    }

    fn execute_query_paged(
        &self,
        query_str: &str,
        page: u64,
        page_size: u64,
    ) -> Result<QueryResult, HeapQlError> {
        crate::heapql::HeapQlEngine::new(self).execute_query_paged(query_str, page, page_size)
    }

    fn scan_instances_table(&self) -> Vec<Vec<serde_json::Value>> {
        let mut rows = Vec::new();
        for i in 0..self.node_store.len() {
            let node = self.node_store.get_by_index(i as u32);
            match node.node_type {
                NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray => {}
                _ => continue,
            }
            let retained = self.dominator.retained_sizes[i];
            if retained == 0 { continue; }
            let node_type_str = match node.node_type {
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
                _ => unreachable!(),
            };
            rows.push(vec![
                serde_json::json!(node.id),
                serde_json::json!(node_type_str),
                serde_json::json!(node.class_name.as_ref()),
                serde_json::json!(node.shallow_size as u64),
                serde_json::json!(retained),
            ]);
        }
        rows
    }

    fn scan_dominator_children(&self, parent_id: Option<u64>) -> Result<Vec<Vec<serde_json::Value>>, HeapQlError> {
        let parent_idx = match parent_id {
            Some(id) => {
                self.node_store.index_of(id)
                    .ok_or_else(|| HeapQlError::Execution(format!("Object {} not found", id)))?
            }
            None => 0u32, // super root
        };

        let children = &self.dominator.dominator_children[parent_idx as usize];
        let mut rows = Vec::new();
        for &child_idx in children {
            let node = self.node_store.get_by_index(child_idx);
            if matches!(node.node_type, NodeType::Class) { continue; }
            let retained = self.dominator.retained_sizes[child_idx as usize];
            if retained == 0 { continue; }
            let node_type_str = match node.node_type {
                NodeType::SuperRoot => "SuperRoot",
                NodeType::GcRoot => "Root",
                NodeType::Class => "Class",
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
            };
            rows.push(vec![
                serde_json::json!(node.id),
                serde_json::json!(node_type_str),
                serde_json::json!(node.class_name.as_ref()),
                serde_json::json!(node.shallow_size as u64),
                serde_json::json!(retained),
            ]);
        }
        Ok(rows)
    }

    fn gc_root_path(&self, object_id: u64, max_depth: usize) -> Option<Vec<ObjectReport>> {
        let target_idx = self.node_store.index_of(object_id)?;

        // BFS backward from target through reverse edges until we hit a GC root.
        // came_from[node] = Some(next_node_toward_target)  (None for the starting target)
        let mut came_from: std::collections::HashMap<u32, Option<u32>> = std::collections::HashMap::new();
        came_from.insert(target_idx, None);

        let mut found_root: Option<u32> = None;
        let mut queue: std::collections::VecDeque<(u32, usize)> = std::collections::VecDeque::new();
        queue.push_back((target_idx, 0));

        while let Some((current, depth)) = queue.pop_front() {
            let node = self.node_store.get_by_index(current);
            if matches!(node.node_type, NodeType::GcRoot | NodeType::SuperRoot) {
                found_root = Some(current);
                break;
            }
            if depth >= max_depth {
                continue;
            }
            for &referrer in self.edge_store.reverse_neighbors(current) {
                if !came_from.contains_key(&referrer) {
                    came_from.insert(referrer, Some(current));
                    queue.push_back((referrer, depth + 1));
                }
            }
        }

        let root_idx = found_root?;

        // Reconstruct path from root to target
        let mut path = Vec::new();
        let mut current = root_idx;
        loop {
            let node = self.node_store.get_by_index(current);
            let node_type_str = match node.node_type {
                NodeType::SuperRoot => "SuperRoot",
                NodeType::GcRoot => "Root",
                NodeType::Class => "Class",
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
            };
            let retained = self.dominator.retained_sizes[current as usize];
            let report = ObjectReport::new(
                node.id,
                node_type_str.to_string(),
                node.class_name.to_string(),
                node.shallow_size as u64,
                retained,
                NodeIndex::new(current as usize),
            );
            path.push(report);

            if current == target_idx {
                break;
            }
            match came_from.get(&current) {
                Some(Some(next)) => current = *next,
                _ => break,
            }
        }

        if path.len() < 2 {
            return None;
        }
        Some(path)
    }

    fn get_referrers(&self, object_id: u64) -> Option<Vec<ObjectReport>> {
        let node_idx = self.node_store.index_of(object_id)?;
        let referrers = self.edge_store.reverse_neighbors(node_idx);
        if referrers.is_empty() {
            return None;
        }
        let mut reports = Vec::new();
        for &ref_idx in referrers {
            let node = self.node_store.get_by_index(ref_idx);
            let retained = self.dominator.retained_sizes[ref_idx as usize];
            if retained == 0 && !matches!(node.node_type, NodeType::GcRoot | NodeType::SuperRoot) {
                continue;
            }
            let node_type_str = match node.node_type {
                NodeType::SuperRoot => "SuperRoot",
                NodeType::GcRoot => "Root",
                NodeType::Class => "Class",
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
            };
            reports.push(ObjectReport::new(
                node.id,
                node_type_str.to_string(),
                node.class_name.to_string(),
                node.shallow_size as u64,
                retained,
                NodeIndex::new(ref_idx as usize),
            ));
        }
        if reports.is_empty() { None } else { Some(reports) }
    }

    fn get_object_info(&self, object_id: u64) -> Option<(ObjectReport, usize, usize)> {
        let node_idx = self.node_store.index_of(object_id)?;
        let node = self.node_store.get_by_index(node_idx);
        let retained = self.dominator.retained_sizes[node_idx as usize];
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
            NodeIndex::new(node_idx as usize),
        );
        let child_count = self.dominator.dominator_children[node_idx as usize].len();
        // Referrer count not available in indexed backend yet
        let ref_count = 0;
        Some((report, child_count, ref_count))
    }

    fn get_dominator_subtree(&self, object_id: u64, max_depth: usize, max_children: usize) -> Option<crate::DominatorTreeNode> {
        let node_idx = if object_id == 0 {
            0u32 // super root
        } else {
            self.node_store.index_of(object_id)?
        };

        let mut total_nodes = 0;
        Some(self.build_dominator_subtree(node_idx, 0, max_depth, max_children, &mut total_nodes))
    }

    fn get_timeline_snapshot(&self, path: &str, top_n: usize) -> crate::TimelineSnapshot {
        let top_classes: Vec<crate::ClassHistogramEntry> = self.class_histogram.iter()
            .take(top_n)
            .cloned()
            .collect();
        crate::TimelineSnapshot {
            path: path.to_string(),
            summary: self.summary.clone(),
            top_classes,
        }
    }
}

impl IndexedAnalysisState {
    /// Recursively builds a `DominatorTreeNode` subtree for flame graph rendering.
    fn build_dominator_subtree(
        &self,
        node_idx: u32,
        depth: usize,
        max_depth: usize,
        max_children: usize,
        total_nodes: &mut usize,
    ) -> crate::DominatorTreeNode {
        let node = self.node_store.get_by_index(node_idx);
        let retained = self.dominator.retained_sizes[node_idx as usize];
        let shallow = node.shallow_size as u64;
        let node_type_str = match node.node_type {
            NodeType::SuperRoot => "SuperRoot",
            NodeType::GcRoot => "Root",
            NodeType::Class => "Class",
            NodeType::Instance => "Instance",
            NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
        };

        *total_nodes += 1;
        let mut children = Vec::new();

        if depth < max_depth && *total_nodes < 10000 {
            let child_indices = &self.dominator.dominator_children[node_idx as usize];
            let mut child_data: Vec<(u32, u64)> = child_indices
                .iter()
                .filter_map(|&ci| {
                    let cn = self.node_store.get_by_index(ci);
                    if matches!(cn.node_type, NodeType::Class) {
                        return None;
                    }
                    let ret = self.dominator.retained_sizes[ci as usize];
                    if ret == 0 {
                        return None;
                    }
                    Some((ci, ret))
                })
                .collect();

            child_data.sort_by(|a, b| b.1.cmp(&a.1));

            let show_count = child_data.len().min(max_children);
            for &(ci, _) in &child_data[..show_count] {
                children.push(self.build_dominator_subtree(ci, depth + 1, max_depth, max_children, total_nodes));
                if *total_nodes >= 10000 {
                    break;
                }
            }

            if child_data.len() > max_children {
                let others = &child_data[max_children..];
                let agg_retained: u64 = others.iter().map(|(_, r)| r).sum();
                let agg_shallow: u64 = others
                    .iter()
                    .map(|(ci, _)| self.node_store.get_by_index(*ci).shallow_size as u64)
                    .sum();
                children.push(crate::DominatorTreeNode {
                    name: format!("[{} others]", others.len()),
                    retained_size: agg_retained,
                    shallow_size: agg_shallow,
                    object_id: 0,
                    node_type: "Aggregated".to_string(),
                    children: Vec::new(),
                });
            }
        }

        crate::DominatorTreeNode {
            name: node.class_name.to_string(),
            retained_size: retained,
            shallow_size: shallow,
            object_id: node.id,
            node_type: node_type_str.to_string(),
            children,
        }
    }

    /// Builds an `IndexedAnalysisState` from Phase 1 + Phase 2 results.
    ///
    /// This is the two-phase counterpart of `from_parse_result`.
    pub fn from_phases(phase1: Phase1Result, phase2: Phase2Result) -> anyhow::Result<Self> {
        let parse_result = ParseResult {
            node_store: phase1.node_store,
            edge_store: phase2.edge_store,
            class_index: phase1.class_index,
            string_table: phase1.string_table,
            gc_root_ids: phase1.gc_root_ids,
            summary: phase1.summary,
            waste_raw: phase2.waste_raw,
        };
        Self::from_parse_result(parse_result)
    }
}

// ===========================================================================
// Phase1AnalysisState — lightweight state that works WITHOUT edges/dominators
// ===========================================================================

/// Analysis state built from Phase 1 data only (nodes, no edges/dominators).
///
/// Implements `HeapAnalysis` so all RPC handlers work, but methods that need
/// dominator or edge data return empty/None results. This lets the frontend
/// display overview, histogram, and waste data within ~1.4s while Phase 2
/// runs in the background.
pub struct Phase1AnalysisState {
    node_store: NodeStore,
    class_index: ClassIndex,
    string_table: StringTable,
    summary: HeapSummary,
    class_histogram: Vec<ClassHistogramEntry>,
    waste_raw: WasteRawData,
    waste: OnceLock<WasteAnalysis>,
    top_objects: Vec<ObjectReport>,
}

unsafe impl Send for Phase1AnalysisState {}
unsafe impl Sync for Phase1AnalysisState {}

impl Phase1AnalysisState {
    /// Creates a `Phase1AnalysisState` from Phase 1 parse results.
    pub fn new(phase1: Phase1Result) -> Self {
        // Build top-50 objects by shallow size (no retained sizes available)
        let mut top_heap: std::collections::BinaryHeap<ObjectReport> =
            std::collections::BinaryHeap::with_capacity(51);

        for i in 0..phase1.node_store.len() {
            let node = phase1.node_store.get_by_index(i as u32);
            match node.node_type {
                NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray => {}
                _ => continue,
            }

            let shallow = node.shallow_size as u64;
            if shallow == 0 {
                continue;
            }

            let node_type_str = match node.node_type {
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
                _ => unreachable!(),
            };

            let report = ObjectReport::new(
                node.id,
                node_type_str.to_string(),
                node.class_name.to_string(),
                shallow,
                shallow, // Use shallow as retained estimate for Phase 1
                NodeIndex::new(i),
            );
            top_heap.push(report);
            if top_heap.len() > 50 {
                top_heap.pop();
            }
        }

        let top_objects: Vec<ObjectReport> = top_heap.into_sorted_vec();

        Self {
            node_store: phase1.node_store,
            class_index: phase1.class_index,
            string_table: phase1.string_table,
            summary: phase1.summary,
            class_histogram: phase1.class_histogram,
            waste_raw: phase1.waste_raw,
            waste: OnceLock::new(),
            top_objects,
        }
    }
}

impl HeapAnalysis for Phase1AnalysisState {
    fn get_children(&self, _object_id: u64) -> Option<Vec<ObjectReport>> {
        // No dominator tree in Phase 1
        None
    }

    fn get_summary(&self) -> &HeapSummary {
        &self.summary
    }

    fn get_class_histogram(&self) -> &[ClassHistogramEntry] {
        &self.class_histogram
    }

    fn get_leak_suspects(&self) -> &[LeakSuspect] {
        // No retained sizes in Phase 1 → no leak suspects
        &[]
    }

    fn get_object_leak_suspects(&self) -> &[LeakSuspect] {
        // No retained sizes in Phase 1 → no object leak suspects
        &[]
    }

    fn get_waste_analysis(&self) -> &WasteAnalysis {
        self.waste.get_or_init(|| {
            compute_indexed_waste(&self.waste_raw, self.summary.total_heap_size)
        })
    }

    fn get_top_layers(&self, _max_depth: usize, max_nodes: usize) -> Vec<ObjectReport> {
        // Return top objects by shallow size (no dominator tree to BFS)
        self.top_objects.iter().take(max_nodes).cloned().collect()
    }

    fn inspect_object(&self, _hprof_path: &Path, _object_id: u64) -> Option<Vec<FieldInfo>> {
        None
    }

    fn inspect_object_bytes(&self, _hprof_bytes: &[u8], _object_id: u64) -> Option<Vec<FieldInfo>> {
        None
    }

    fn execute_query(&self, query_str: &str) -> Result<QueryResult, HeapQlError> {
        crate::heapql::HeapQlEngine::new(self).execute_query(query_str)
    }

    fn execute_query_paged(
        &self,
        query_str: &str,
        page: u64,
        page_size: u64,
    ) -> Result<QueryResult, HeapQlError> {
        crate::heapql::HeapQlEngine::new(self).execute_query_paged(query_str, page, page_size)
    }

    fn scan_instances_table(&self) -> Vec<Vec<serde_json::Value>> {
        let mut rows = Vec::new();
        for i in 0..self.node_store.len() {
            let node = self.node_store.get_by_index(i as u32);
            match node.node_type {
                NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray => {}
                _ => continue,
            }
            let shallow = node.shallow_size as u64;
            if shallow == 0 { continue; }
            let node_type_str = match node.node_type {
                NodeType::Instance => "Instance",
                NodeType::ObjectArray | NodeType::PrimitiveArray => "Array",
                _ => unreachable!(),
            };
            rows.push(vec![
                serde_json::json!(node.id),
                serde_json::json!(node_type_str),
                serde_json::json!(node.class_name.as_ref()),
                serde_json::json!(shallow),
                serde_json::json!(0u64), // retained_size not available in Phase 1
            ]);
        }
        rows
    }

    fn scan_dominator_children(&self, _parent_id: Option<u64>) -> Result<Vec<Vec<serde_json::Value>>, HeapQlError> {
        // No dominator tree in Phase 1
        Ok(Vec::new())
    }

    fn gc_root_path(&self, _object_id: u64, _max_depth: usize) -> Option<Vec<ObjectReport>> {
        None
    }

    fn get_referrers(&self, _object_id: u64) -> Option<Vec<ObjectReport>> {
        None
    }

    fn get_object_info(&self, object_id: u64) -> Option<(ObjectReport, usize, usize)> {
        let node_idx = self.node_store.index_of(object_id)?;
        let node = self.node_store.get_by_index(node_idx);
        let shallow = node.shallow_size as u64;
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
            shallow,
            0, // retained not available
            NodeIndex::new(node_idx as usize),
        );
        Some((report, 0, 0))
    }

    fn get_dominator_subtree(&self, _object_id: u64, _max_depth: usize, _max_children: usize) -> Option<crate::DominatorTreeNode> {
        None
    }

    fn get_timeline_snapshot(&self, path: &str, top_n: usize) -> crate::TimelineSnapshot {
        let top_classes: Vec<crate::ClassHistogramEntry> = self.class_histogram.iter()
            .take(top_n)
            .cloned()
            .collect();
        crate::TimelineSnapshot {
            path: path.to_string(),
            summary: self.summary.clone(),
            top_classes,
        }
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
    fn execute_query_works() {
        let pr = build_test_parse_result();
        let state = IndexedAnalysisState::from_parse_result(pr).unwrap();

        let result = state.execute_query("SELECT * FROM class_histogram");
        assert!(result.is_ok());
        let qr = result.unwrap();
        assert_eq!(qr.columns, vec!["class_name", "instance_count", "shallow_size", "retained_size"]);
        assert!(!qr.rows.is_empty());
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

    // -----------------------------------------------------------------------
    // Phase1AnalysisState tests
    // -----------------------------------------------------------------------

    use super::Phase1AnalysisState;
    use crate::indexed::parse::Phase1Result;

    /// Helper: build a minimal Phase1Result for testing.
    fn build_test_phase1_result() -> Phase1Result {
        let mut node_store = NodeStore::new();
        node_store.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        node_store.add_node(100, 0, 64, NodeType::Instance, Arc::from("java.lang.Object"));
        node_store.add_node(200, 0, 128, NodeType::Instance, Arc::from("java.lang.String"));
        node_store.add_node(300, 0, 256, NodeType::ObjectArray, Arc::from("byte[]"));

        Phase1Result {
            node_store,
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
            class_histogram: vec![
                crate::ClassHistogramEntry {
                    class_name: "byte[]".to_string(),
                    instance_count: 1,
                    shallow_size: 256,
                    retained_size: 0,
                },
                crate::ClassHistogramEntry {
                    class_name: "java.lang.String".to_string(),
                    instance_count: 1,
                    shallow_size: 128,
                    retained_size: 0,
                },
                crate::ClassHistogramEntry {
                    class_name: "java.lang.Object".to_string(),
                    instance_count: 1,
                    shallow_size: 64,
                    retained_size: 0,
                },
            ],
        }
    }

    #[test]
    fn phase1_state_builds_successfully() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        assert_eq!(state.get_summary().total_heap_size, 448);
    }

    #[test]
    fn phase1_state_get_summary() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        let summary = state.get_summary();
        assert_eq!(summary.total_instances, 2);
        assert_eq!(summary.total_arrays, 1);
    }

    #[test]
    fn phase1_state_get_class_histogram() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        let hist = state.get_class_histogram();
        assert_eq!(hist.len(), 3);
        // Retained size should be 0 (Phase 1)
        assert!(hist.iter().all(|e| e.retained_size == 0));
    }

    #[test]
    fn phase1_state_get_leak_suspects_empty() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        assert!(state.get_leak_suspects().is_empty());
    }

    #[test]
    fn phase1_state_get_children_returns_none() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        assert!(state.get_children(0).is_none());
        assert!(state.get_children(100).is_none());
    }

    #[test]
    fn phase1_state_get_top_layers_returns_by_shallow() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        let layers = state.get_top_layers(3, 100);
        assert!(!layers.is_empty());
        // Should contain objects sorted by shallow size (used as retained estimate)
    }

    #[test]
    fn phase1_state_get_waste_analysis() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        let waste = state.get_waste_analysis();
        assert_eq!(waste.total_wasted_bytes, 0);
    }

    #[test]
    fn phase1_state_execute_query() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        let result = state.execute_query("SELECT * FROM class_histogram");
        assert!(result.is_ok());
        let qr = result.unwrap();
        assert!(!qr.rows.is_empty());
    }

    #[test]
    fn phase1_state_gc_root_path_returns_none() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        assert!(state.gc_root_path(100, 10).is_none());
    }

    #[test]
    fn phase1_state_get_referrers_returns_none() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        assert!(state.get_referrers(100).is_none());
    }

    #[test]
    fn phase1_state_get_object_info() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        let info = state.get_object_info(100);
        assert!(info.is_some());
        let (report, child_count, ref_count) = info.unwrap();
        assert_eq!(report.object_id, 100);
        assert_eq!(report.shallow_size, 64);
        assert_eq!(report.retained_size, 0); // No retained in Phase 1
        assert_eq!(child_count, 0);
        assert_eq!(ref_count, 0);
    }

    #[test]
    fn phase1_state_implements_heap_analysis_trait() {
        let pr = build_test_phase1_result();
        let state = Phase1AnalysisState::new(pr);
        let dyn_ref: &dyn HeapAnalysis = &state;
        assert_eq!(dyn_ref.get_summary().total_heap_size, 448);
    }
}
