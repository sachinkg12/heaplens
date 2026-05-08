//! Single-pass HPROF parser producing indexed data structures.
//!
//! Replaces the multi-pass `build_graph` function in `lib.rs` with a
//! streamlined parser that collects all data in one file scan, then
//! resolves class field layouts and extracts edges in a second
//! in-memory pass over cached instance data.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use jvm_hprof::{parse_hprof, IdSize, RecordTag};
use rayon::prelude::*;

use crate::graph_builder::{
    convert_jvm_class_name, extract_object_references_fallback,
    extract_typed_references_named, types_only,
};
use crate::waste::{
    extract_nth_field_of_type, hash_bytes,
    BackingArrayInfo, BoxedPrimitiveInfo, EmptyCollectionInfo,
    OverAllocatedCollectionInfo, StringInstanceInfo, WasteRawData,
};
use crate::HeapSummary;

use super::class_index::{ClassIndex, ClassInfo, FieldDescriptor};
use super::edge_store::{label, EdgeBuilder, EdgeStore};
use super::node_store::{NodeStore, NodeType};
use super::string_table::StringTable;

/// Cached instance record for deferred edge extraction.
pub struct DeferredInstance {
    /// Index of this instance in the NodeStore.
    pub node_idx: u32,
    /// Class object ID (for layout lookup).
    pub class_obj_id: u64,
    /// Raw field bytes (copied from the HPROF data).
    pub field_bytes: Vec<u8>,
}

/// Cached object array element references for deferred edge extraction.
pub struct DeferredObjectArray {
    /// Index of the array node in the NodeStore.
    pub node_idx: u32,
    /// Non-zero HPROF IDs of referenced objects.
    pub element_refs: Vec<u64>,
}

/// Cached class structural edges for deferred edge extraction.
pub struct DeferredClassEdge {
    /// Index of the class node in the NodeStore.
    pub class_node_idx: u32,
    /// Super class object ID (None if java.lang.Object or 0).
    pub super_class_id: Option<u64>,
    /// Classloader object ID (None if bootstrap/0).
    pub classloader_id: Option<u64>,
    /// Static field references: (ref_id,) for ObjectId-type statics with non-zero values.
    pub static_field_refs: Vec<u64>,
}

/// The result of parsing an HPROF file with the indexed backend.
pub struct ParseResult {
    pub node_store: NodeStore,
    pub edge_store: EdgeStore,
    pub class_index: ClassIndex,
    pub string_table: StringTable,
    pub gc_root_ids: Vec<u64>,
    pub summary: HeapSummary,
    pub waste_raw: WasteRawData,
}

/// Result of Phase 1 parsing (nodes only, ~1.4s on 14 GB dumps).
///
/// Contains everything needed for overview, histogram, and waste analysis
/// without requiring edge extraction or dominator computation.
pub struct Phase1Result {
    pub node_store: NodeStore,
    pub class_index: ClassIndex,
    pub string_table: StringTable,
    pub gc_root_ids: Vec<u64>,
    pub summary: HeapSummary,
    pub waste_raw: WasteRawData,
    /// Class histogram computed from shallow sizes only.
    pub class_histogram: Vec<crate::ClassHistogramEntry>,
}

/// Data deferred from Phase 1 that Phase 2 needs for edge extraction.
pub struct DeferredEdgeData {
    pub deferred_instances: Vec<DeferredInstance>,
    pub deferred_arrays: Vec<DeferredObjectArray>,
    pub deferred_class_edges: Vec<DeferredClassEdge>,
    pub class_name_map: HashMap<u64, Arc<str>>,
    pub class_instance_sizes: HashMap<u64, u32>,
    pub id_size: jvm_hprof::IdSize,
    pub array_element_counts: HashMap<u64, u32>,
    pub classloader_ids: std::collections::HashSet<u64>,
}

/// Result of Phase 2 parsing (edges + CSR).
///
/// No longer requires a file rescan — all data is collected during Phase 1.
pub struct Phase2Result {
    pub edge_store: EdgeStore,
    /// Waste data (backing array content hashing is unavailable without file rescan;
    /// string instance counts, empty collections, and boxed primitives are still present).
    pub waste_raw: WasteRawData,
}

/// Helper: register a GC root node.
fn add_gc_root(
    obj_id: u64,
    gc_root_ids: &mut Vec<u64>,
    gc_root_count: &mut u64,
    node_store: &mut NodeStore,
) {
    gc_root_ids.push(obj_id);
    *gc_root_count += 1;
    if node_store.index_of(obj_id).is_none() {
        let rn: Arc<str> = Arc::from("GcRoot");
        node_store.add_node(obj_id, 0, 0, NodeType::GcRoot, rn);
    }
}

/// Parses an HPROF file into indexed data structures.
///
/// This is the backward-compatible entry point that calls Phase 1 + Phase 2
/// internally and returns a complete `ParseResult`.
pub fn parse_indexed(data: &[u8]) -> Result<ParseResult> {
    let (phase1, deferred) = parse_indexed_phase1(data)?;
    let phase2 = parse_indexed_phase2(&phase1, deferred)?;

    Ok(ParseResult {
        node_store: phase1.node_store,
        edge_store: phase2.edge_store,
        class_index: phase1.class_index,
        string_table: phase1.string_table,
        gc_root_ids: phase1.gc_root_ids,
        summary: phase1.summary,
        waste_raw: phase2.waste_raw,
    })
}

/// Phase 1: Single file scan collecting nodes, class metadata, and GC roots.
///
/// Returns the Phase1Result (nodes, summary, histogram, waste candidates)
/// and DeferredEdgeData needed for Phase 2 edge extraction.
/// Takes ~1.4s on a 14 GB dump.
pub fn parse_indexed_phase1(data: &[u8]) -> Result<(Phase1Result, DeferredEdgeData)> {
    let hprof = parse_hprof(data)
        .map_err(|e| anyhow::anyhow!("Failed to parse HPROF file: {:?}", e))?;

    let id_size = hprof.header().id_size();
    let hprof_version = hprof
        .header()
        .label()
        .unwrap_or("unknown")
        .to_string();

    // Capacity estimates based on file size
    let estimated_nodes = (data.len() / 100).max(1024);
    let estimated_strings = (data.len() / 500).max(256);

    let mut string_table = StringTable::with_capacity(estimated_strings);
    let mut load_class_entries: Vec<(u64, u64)> = Vec::new();
    let mut class_index = ClassIndex::with_capacity(estimated_nodes / 10);
    let mut node_store = NodeStore::with_capacity(estimated_nodes);
    let mut gc_root_ids: Vec<u64> = Vec::new();
    let mut deferred_instances: Vec<DeferredInstance> = Vec::with_capacity(estimated_nodes);
    let mut deferred_arrays: Vec<DeferredObjectArray> = Vec::new();
    let mut deferred_class_edges: Vec<DeferredClassEdge> = Vec::new();
    let mut heap_types: Vec<String> = Vec::new();

    // Class name map: class_obj_id -> human-readable name
    let mut class_name_map: HashMap<u64, Arc<str>> = HashMap::with_capacity(estimated_nodes / 10);
    // Instance sizes from ClassDump records
    let mut class_instance_sizes: HashMap<u64, u32> = HashMap::new();
    // Field name intern pool
    let mut field_name_intern: HashMap<u64, Arc<str>> = HashMap::new();
    // Classloader IDs
    let mut classloader_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Array element counts for waste analysis
    let mut array_element_counts: HashMap<u64, u32> = HashMap::new();

    // Backing array info for string dedup waste analysis (byte[] and char[] content hashes)
    let mut backing_arrays: HashMap<u64, BackingArrayInfo> = HashMap::new();

    // Track object array node indices to their array_class_obj_id for deferred name fixup
    let mut object_array_class_ids: Vec<(u32, u64)> = Vec::new();

    // Counters
    let mut instance_count = 0u64;
    let mut array_count = 0u64;
    let mut class_count = 0u64;
    let mut gc_root_count = 0u64;
    let mut total_shallow_size = 0u64;

    // Add SuperRoot node at index 0
    let super_root_name: Arc<str> = Arc::from("SuperRoot");
    let _super_root_idx =
        node_store.add_node(0, 0, 0, NodeType::SuperRoot, super_root_name);

    // ========================================================================
    // Pass 1: Single scan of all records
    // ========================================================================

    for record_result in hprof.records_iter() {
        let record = record_result
            .map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;

        match record.tag() {
            RecordTag::Utf8 => {
                if let Some(utf8_result) = record.as_utf_8() {
                    let utf8 = utf8_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse UTF8 string: {:?}", e))?;
                    let string_id = utf8.name_id().id();
                    let text = String::from_utf8_lossy(utf8.text());
                    string_table.insert(string_id, &text);
                }
            }
            RecordTag::LoadClass => {
                if let Some(lc_result) = record.as_load_class() {
                    let lc = lc_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse LoadClass: {:?}", e))?;
                    load_class_entries
                        .push((lc.class_obj_id().id(), lc.class_name_id().id()));
                }
            }
            RecordTag::HeapDump | RecordTag::HeapDumpSegment => {
                if let Some(hd_result) = record.as_heap_dump_segment() {
                    let heap_dump = hd_result.map_err(|e| {
                        anyhow::anyhow!("Failed to parse HeapDumpSegment: {:?}", e)
                    })?;

                    for sub_result in heap_dump.sub_records() {
                        let sub = sub_result.map_err(|e| {
                            anyhow::anyhow!("Failed to parse sub-record: {:?}", e)
                        })?;

                        match sub {
                            // ---- ClassDump: collect metadata ----
                            jvm_hprof::heap_dump::SubRecord::Class(class) => {
                                let obj_id = class.obj_id().id();
                                let instance_size = class.instance_size_bytes();
                                class_instance_sizes.insert(obj_id, instance_size);

                                let super_id = class.super_class_obj_id().map(|id| id.id());
                                let mut own_fields = Vec::new();
                                for fd_result in class.instance_field_descriptors() {
                                    if let Ok(fd) = fd_result {
                                        let name_id = fd.name_id().id();
                                        let field_name = field_name_intern
                                            .entry(name_id)
                                            .or_insert_with(|| {
                                                let name = string_table
                                                    .get(name_id)
                                                    .map(|s| s.as_ref())
                                                    .unwrap_or("<unknown>");
                                                Arc::from(name)
                                            })
                                            .clone();
                                        own_fields.push(FieldDescriptor {
                                            name: field_name,
                                            field_type: fd.field_type(),
                                        });
                                    }
                                }

                                // Track classloader IDs
                                if let Some(cl_id) = class.class_loader_obj_id() {
                                    let cl_val = cl_id.id();
                                    if cl_val != 0 {
                                        classloader_ids.insert(cl_val);
                                    }
                                }

                                // We don't know the class name yet (LoadClass may
                                // not have been processed for this ID), so store
                                // a placeholder and fix up later.
                                class_index.insert(
                                    obj_id,
                                    ClassInfo {
                                        class_name: Arc::from(""),
                                        instance_size,
                                        super_class_id: super_id,
                                        field_descriptors: own_fields,
                                    },
                                );

                                // Add class node if not already present
                                if node_store.index_of(obj_id).is_none() {
                                    let cn: Arc<str> = Arc::from("Class");
                                    node_store.add_node(
                                        obj_id,
                                        0,
                                        0,
                                        NodeType::Class,
                                        cn,
                                    );
                                    class_count += 1;
                                }

                                // Collect class structural edges for Phase 2
                                // (target nodes may not exist yet during Phase 1)
                                if let Some(class_idx) = node_store.index_of(obj_id) {
                                    let super_class_id = class.super_class_obj_id().map(|id| id.id()).filter(|&id| id != 0);
                                    let classloader_id = class.class_loader_obj_id().map(|id| id.id()).filter(|&id| id != 0);

                                    let mut static_field_refs = Vec::new();
                                    for sf_result in class.static_fields() {
                                        if let Ok(sf) = sf_result {
                                            if matches!(
                                                sf.field_type(),
                                                jvm_hprof::heap_dump::FieldType::ObjectId
                                            ) {
                                                if let jvm_hprof::heap_dump::FieldValue::ObjectId(
                                                    Some(ref_id),
                                                ) = sf.value()
                                                {
                                                    let ref_id_val = ref_id.id();
                                                    if ref_id_val != 0 {
                                                        static_field_refs.push(ref_id_val);
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    deferred_class_edges.push(DeferredClassEdge {
                                        class_node_idx: class_idx,
                                        super_class_id,
                                        classloader_id,
                                        static_field_refs,
                                    });
                                }
                            }

                            // ---- GC Roots ----
                            // Each GC root variant is a different type, so we use
                            // a macro to avoid repeating the body.
                            jvm_hprof::heap_dump::SubRecord::GcRootUnknown(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootJniGlobal(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootJniLocalRef(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootJavaStackFrame(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootSystemClass(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootBusyMonitor(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootInternedString(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootFinalizing(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootDebugger(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootReferenceCleanup(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootVmInternal(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootJniMonitor(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootUnreachable(gc) => {
                                add_gc_root(gc.obj_id().id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                            }
                            jvm_hprof::heap_dump::SubRecord::GcRootThreadObj(gc) => {
                                if let Some(thread_obj_id) = gc.thread_obj_id() {
                                    add_gc_root(thread_obj_id.id(), &mut gc_root_ids, &mut gc_root_count, &mut node_store);
                                }
                            }

                            // ---- Instance ----
                            jvm_hprof::heap_dump::SubRecord::Instance(instance) => {
                                let obj_id = instance.obj_id().id();
                                let class_obj_id = instance.class_obj_id().id();
                                let size = class_instance_sizes
                                    .get(&class_obj_id)
                                    .copied()
                                    .unwrap_or(instance.fields().len() as u32);
                                let class_name = class_name_map
                                    .get(&class_obj_id)
                                    .cloned()
                                    .unwrap_or_else(|| {
                                        Arc::from(
                                            format!("Unknown(0x{:x})", class_obj_id).as_str(),
                                        )
                                    });

                                let existing = node_store.index_of(obj_id);
                                let node_idx = if let Some(idx) = existing {
                                    // Upgrade GcRoot -> Instance
                                    let node = node_store.get_by_index_mut(idx);
                                    if node.node_type == NodeType::GcRoot {
                                        node.node_type = NodeType::Instance;
                                        node.shallow_size = size;
                                        node.class_name = class_name.clone();
                                        instance_count += 1;
                                        total_shallow_size += size as u64;
                                    }
                                    idx
                                } else {
                                    let idx = node_store.add_node(
                                        obj_id,
                                        0,
                                        size,
                                        NodeType::Instance,
                                        class_name.clone(),
                                    );
                                    instance_count += 1;
                                    total_shallow_size += size as u64;
                                    idx
                                };

                                // Cache field bytes for deferred edge extraction
                                deferred_instances.push(DeferredInstance {
                                    node_idx,
                                    class_obj_id,
                                    field_bytes: instance.fields().to_vec(),
                                });
                            }

                            // ---- Object Array ----
                            jvm_hprof::heap_dump::SubRecord::ObjectArray(array) => {
                                let obj_id = array.obj_id().id();
                                let array_class_obj_id = array.array_class_obj_id().id();
                                let id_size_bytes: u32 = match id_size {
                                    IdSize::U32 => 4,
                                    IdSize::U64 => 8,
                                };

                                // Use num_elements() from the HPROF header (O(1))
                                // instead of iterating to count. Still iterate
                                // for collecting non-null element references.
                                let element_count = array.num_elements();
                                let mut element_refs: Vec<u64> = Vec::new();
                                for el_result in array.elements(id_size) {
                                    if let Ok(Some(el_id)) = el_result {
                                        let ref_id = el_id.id();
                                        if ref_id != 0 {
                                            element_refs.push(ref_id);
                                        }
                                    }
                                }

                                let size = element_count * id_size_bytes;
                                // Use a placeholder; LoadClass may not be processed yet.
                                // Will be fixed up after class_name_map is populated.
                                let class_name = class_name_map
                                    .get(&array_class_obj_id)
                                    .cloned()
                                    .unwrap_or_else(|| Arc::from("Object[]"));
                                array_element_counts.insert(obj_id, element_count);

                                let existing = node_store.index_of(obj_id);
                                let node_idx = if let Some(idx) = existing {
                                    let node = node_store.get_by_index_mut(idx);
                                    if node.node_type == NodeType::GcRoot {
                                        node.node_type = NodeType::ObjectArray;
                                        node.shallow_size = size;
                                        node.class_name = class_name;
                                        array_count += 1;
                                        total_shallow_size += size as u64;
                                    }
                                    idx
                                } else {
                                    let idx = node_store.add_node(
                                        obj_id,
                                        0,
                                        size,
                                        NodeType::ObjectArray,
                                        class_name,
                                    );
                                    array_count += 1;
                                    total_shallow_size += size as u64;
                                    idx
                                };

                                // Track for deferred class name fixup
                                object_array_class_ids.push((node_idx, array_class_obj_id));

                                // Store element refs for deferred edge extraction in Phase 2
                                if !element_refs.is_empty() {
                                    deferred_arrays.push(DeferredObjectArray {
                                        node_idx,
                                        element_refs,
                                    });
                                }
                            }

                            // ---- Primitive Array ----
                            jvm_hprof::heap_dump::SubRecord::PrimitiveArray(array) => {
                                let obj_id = array.obj_id().id();
                                let prim_type = array.primitive_type();
                                // Use num_elements() from the HPROF header directly (O(1))
                                // instead of iterating all elements via typed iterators.
                                let elem_count = array.num_elements();
                                let (elem_size, class_name): (u32, Arc<str>) =
                                    match prim_type {
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Boolean => {
                                            (1, Arc::from("boolean[]"))
                                        }
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Byte => {
                                            (1, Arc::from("byte[]"))
                                        }
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Char => {
                                            (2, Arc::from("char[]"))
                                        }
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Short => {
                                            (2, Arc::from("short[]"))
                                        }
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Int => {
                                            (4, Arc::from("int[]"))
                                        }
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Float => {
                                            (4, Arc::from("float[]"))
                                        }
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Long => {
                                            (8, Arc::from("long[]"))
                                        }
                                        jvm_hprof::heap_dump::PrimitiveArrayType::Double => {
                                            (8, Arc::from("double[]"))
                                        }
                                    };

                                let size = elem_count * elem_size;
                                array_element_counts.insert(obj_id, elem_count);

                                // Hash byte[] and char[] content for string dedup waste analysis
                                if matches!(prim_type,
                                    jvm_hprof::heap_dump::PrimitiveArrayType::Byte |
                                    jvm_hprof::heap_dump::PrimitiveArrayType::Char
                                ) {
                                    let raw_data = array.contents();
                                    if !raw_data.is_empty() {
                                        let content_hash = hash_bytes(raw_data);
                                        // Build a short preview (first 120 chars or equivalent)
                                        let preview = match prim_type {
                                            jvm_hprof::heap_dump::PrimitiveArrayType::Char => {
                                                // char[] is big-endian u16 pairs
                                                let chars: Vec<char> = raw_data.chunks_exact(2)
                                                    .take(120)
                                                    .filter_map(|c| {
                                                        let val = u16::from_be_bytes([c[0], c[1]]);
                                                        char::from_u32(val as u32)
                                                    })
                                                    .collect();
                                                chars.into_iter().collect::<String>()
                                            }
                                            _ => {
                                                // byte[] — try UTF-8 decode
                                                let len = raw_data.len().min(120);
                                                String::from_utf8_lossy(&raw_data[..len]).to_string()
                                            }
                                        };
                                        backing_arrays.insert(obj_id, BackingArrayInfo {
                                            content_hash,
                                            size,
                                            preview,
                                        });
                                    }
                                }

                                let existing = node_store.index_of(obj_id);
                                if let Some(idx) = existing {
                                    let node = node_store.get_by_index_mut(idx);
                                    if node.node_type == NodeType::GcRoot {
                                        node.node_type = NodeType::PrimitiveArray;
                                        node.shallow_size = size;
                                        node.class_name = class_name;
                                        array_count += 1;
                                        total_shallow_size += size as u64;
                                    }
                                } else {
                                    node_store.add_node(
                                        obj_id,
                                        0,
                                        size,
                                        NodeType::PrimitiveArray,
                                        class_name,
                                    );
                                    array_count += 1;
                                    total_shallow_size += size as u64;
                                }
                            }

                            // ---- PrimitiveArrayNoData (Android) ----
                            jvm_hprof::heap_dump::SubRecord::PrimitiveArrayNoData(array) => {
                                let obj_id = array.obj_id().id();
                                let prim_type = array.primitive_type();
                                let class_name: Arc<str> = Arc::from(
                                    format!("{}[]", prim_type.java_type_name()).as_str(),
                                );

                                let existing = node_store.index_of(obj_id);
                                if let Some(idx) = existing {
                                    let node = node_store.get_by_index_mut(idx);
                                    if node.node_type == NodeType::GcRoot {
                                        node.node_type = NodeType::PrimitiveArray;
                                        node.shallow_size = 0;
                                        node.class_name = class_name;
                                        array_count += 1;
                                    }
                                } else {
                                    node_store.add_node(
                                        obj_id,
                                        0,
                                        0,
                                        NodeType::PrimitiveArray,
                                        class_name,
                                    );
                                    array_count += 1;
                                }
                            }

                            // ---- HeapDumpInfo (Android heap regions) ----
                            jvm_hprof::heap_dump::SubRecord::HeapDumpInfo(info) => {
                                let heap_name_id = info.heap_name_id().id();
                                if let Some(name) = string_table.get(heap_name_id) {
                                    let name_str = name.to_string();
                                    if !heap_types.contains(&name_str) {
                                        heap_types.push(name_str);
                                    }
                                }
                            }

                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // ========================================================================
    // Resolve class names from LoadClass entries
    // ========================================================================

    for &(class_obj_id, class_name_id) in &load_class_entries {
        if let Some(name) = string_table.get(class_name_id) {
            let java_name = convert_jvm_class_name(name);
            let arc_name: Arc<str> = Arc::from(java_name.as_str());
            class_name_map.insert(class_obj_id, arc_name.clone());

            // Fix up ClassInfo class_name
            if let Some(ci) = class_index.get(class_obj_id) {
                if ci.class_name.is_empty() {
                    // We need mutable access — rebuild the entry
                    let mut info = ci.clone();
                    info.class_name = arc_name.clone();
                    class_index.insert(class_obj_id, info);
                }
            }
        }

        // Ensure class node exists
        if node_store.index_of(class_obj_id).is_none() {
            let cn: Arc<str> = Arc::from("Class");
            node_store.add_node(class_obj_id, 0, 0, NodeType::Class, cn);
            class_count += 1;
        }
    }

    // Fix up Class node names (they were stored as "Class" placeholder
    // because LoadClass may not have been processed yet)
    for i in 0..node_store.len() {
        let node = node_store.get_by_index(i as u32);
        if matches!(node.node_type, NodeType::Class) && node.class_name.as_ref() == "Class" {
            if let Some(name) = class_name_map.get(&node.id) {
                let node_mut = node_store.get_by_index_mut(i as u32);
                node_mut.class_name = Arc::from(format!("class {}", name.as_ref()));
            }
        }
    }

    // Fix up deferred instance class names (instances whose class was Unknown
    // because LoadClass hadn't been processed yet)
    for di in &deferred_instances {
        if let Some(name) = class_name_map.get(&di.class_obj_id) {
            let node = node_store.get_by_index(di.node_idx);
            if node.class_name.starts_with("Unknown(") {
                let node_mut = node_store.get_by_index_mut(di.node_idx);
                node_mut.class_name = name.clone();
            }
        }
    }

    // Fix up object array class names (arrays whose class name defaulted to
    // "Object[]" because LoadClass hadn't been processed yet)
    for &(node_idx, array_class_obj_id) in &object_array_class_ids {
        if let Some(name) = class_name_map.get(&array_class_obj_id) {
            let node = node_store.get_by_index(node_idx);
            if node.class_name.as_ref() == "Object[]" {
                let node_mut = node_store.get_by_index_mut(node_idx);
                node_mut.class_name = name.clone();
            }
        }
    }

    // ========================================================================
    // Resolve class field layouts
    // ========================================================================

    class_index.resolve_field_layouts();
    drop(field_name_intern);

    // ========================================================================
    // Build class histogram from shallow sizes (no retained sizes yet)
    // ========================================================================

    let mut histogram_map: HashMap<String, (u64, u64)> = HashMap::new();
    for i in 0..node_store.len() {
        let node = node_store.get_by_index(i as u32);
        match node.node_type {
            NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray => {}
            _ => continue,
        }
        let shallow = node.shallow_size as u64;
        let class_name = node.class_name.to_string();
        let entry = histogram_map.entry(class_name).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += shallow;
    }

    let mut class_histogram: Vec<crate::ClassHistogramEntry> = histogram_map
        .into_iter()
        .map(|(class_name, (instance_count_val, shallow_size))| {
            crate::ClassHistogramEntry {
                class_name,
                instance_count: instance_count_val,
                shallow_size,
                retained_size: 0, // Not yet computed — requires dominators
            }
        })
        .collect();
    class_histogram.sort_by(|a, b| b.shallow_size.cmp(&a.shallow_size));

    // ========================================================================
    // Build waste_raw with array_element_counts (Phase 1 portion)
    // ========================================================================

    let mut waste_raw = WasteRawData::new();
    // Merge backing array content hashes collected during PrimitiveArray parsing
    waste_raw.backing_arrays = backing_arrays;
    // Collect waste data from deferred instances (in-memory, no file scan needed)
    {
        let string_class_id: Option<u64> = class_name_map
            .iter()
            .find(|(_, name)| name.as_ref() == "java.lang.String")
            .map(|(id, _)| *id);
        let hashmap_class_id: Option<u64> = class_name_map
            .iter()
            .find(|(_, name)| name.as_ref() == "java.util.HashMap")
            .map(|(id, _)| *id);
        let linked_hashmap_class_id: Option<u64> = class_name_map
            .iter()
            .find(|(_, name)| name.as_ref() == "java.util.LinkedHashMap")
            .map(|(id, _)| *id);
        let arraylist_class_id: Option<u64> = class_name_map
            .iter()
            .find(|(_, name)| name.as_ref() == "java.util.ArrayList")
            .map(|(id, _)| *id);

        let boxed_primitive_names: [(&str, u32); 8] = [
            ("java.lang.Boolean", 1),
            ("java.lang.Byte", 1),
            ("java.lang.Character", 2),
            ("java.lang.Short", 2),
            ("java.lang.Integer", 4),
            ("java.lang.Float", 4),
            ("java.lang.Long", 8),
            ("java.lang.Double", 8),
        ];
        let boxed_ids: HashMap<u64, (&str, u32)> = boxed_primitive_names
            .iter()
            .filter_map(|&(name, ps)| {
                class_name_map
                    .iter()
                    .find(|(_, n)| n.as_ref() == name)
                    .map(|(id, _)| (*id, (name, ps)))
            })
            .collect();

        waste_raw.array_element_counts = array_element_counts.clone();

        for di in &deferred_instances {
            let fields = &di.field_bytes;
            let class_obj_id = di.class_obj_id;

            if let Some(field_layout) = class_index.field_layout(class_obj_id) {
                let ft = types_only(field_layout);

                // Waste: String value references
                if string_class_id == Some(class_obj_id) {
                    if let Some(value_array_id) = extract_nth_field_of_type(
                        fields,
                        id_size,
                        &ft,
                        jvm_hprof::heap_dump::FieldType::ObjectId,
                        0,
                    ) {
                        if value_array_id != 0 {
                            let shallow = class_instance_sizes
                                .get(&class_obj_id)
                                .copied()
                                .unwrap_or(fields.len() as u32);
                            waste_raw.string_instances.push(StringInstanceInfo {
                                value_array_id,
                                shallow_size: shallow,
                            });
                        }
                    }
                }

                // Waste: empty + over-allocated collections
                let is_collection = hashmap_class_id == Some(class_obj_id)
                    || linked_hashmap_class_id == Some(class_obj_id)
                    || arraylist_class_id == Some(class_obj_id);
                if is_collection {
                    if let Some(size_val) = extract_nth_field_of_type(
                        fields,
                        id_size,
                        &ft,
                        jvm_hprof::heap_dump::FieldType::Int,
                        0,
                    ) {
                        let cname = class_name_map
                            .get(&class_obj_id)
                            .map(|s| s.to_string())
                            .unwrap_or_default();
                        let shallow = class_instance_sizes
                            .get(&class_obj_id)
                            .copied()
                            .unwrap_or(fields.len() as u32);
                        if size_val == 0 {
                            waste_raw.empty_collections.push(EmptyCollectionInfo {
                                class_name: cname,
                                shallow_size: shallow,
                            });
                        } else if let Some(backing_array_id) = extract_nth_field_of_type(
                            fields,
                            id_size,
                            &ft,
                            jvm_hprof::heap_dump::FieldType::ObjectId,
                            0,
                        ) {
                            if let Some(&capacity) =
                                waste_raw.array_element_counts.get(&backing_array_id)
                            {
                                let size_u32 = size_val as u32;
                                if capacity > 4 * size_u32 && capacity > 16 {
                                    waste_raw
                                        .over_allocated_collections
                                        .push(OverAllocatedCollectionInfo {
                                            class_name: cname,
                                            size: size_u32,
                                            capacity,
                                        });
                                }
                            }
                        }
                    }
                }

            }

            // Waste: boxed primitives (outside field_layout check —
            // boxed primitives may not have field layouts resolved)
            if let Some(&(bp_name, _prim_size)) = boxed_ids.get(&class_obj_id) {
                let shallow = class_instance_sizes
                    .get(&class_obj_id)
                    .copied()
                    .unwrap_or(fields.len() as u32);
                waste_raw.boxed_primitives.push(BoxedPrimitiveInfo {
                    class_name: bp_name.to_string(),
                    shallow_size: shallow,
                });
            }
        }
    }

    let summary = HeapSummary {
        total_heap_size: total_shallow_size,
        reachable_heap_size: total_shallow_size,
        total_instances: instance_count,
        total_classes: class_count,
        total_arrays: array_count,
        total_gc_roots: gc_root_count,
        hprof_version,
        heap_types,
    };

    let deferred = DeferredEdgeData {
        deferred_instances,
        deferred_arrays,
        deferred_class_edges,
        class_name_map,
        class_instance_sizes,
        id_size,
        array_element_counts,
        classloader_ids,
    };

    let phase1 = Phase1Result {
        node_store,
        class_index,
        string_table,
        gc_root_ids,
        summary,
        waste_raw,
        class_histogram,
    };

    Ok((phase1, deferred))
}

/// Phase 2: Extract edges from deferred data collected during Phase 1.
///
/// No longer requires a file rescan. All object array element references,
/// class structural edges, and instance field edges are resolved from
/// in-memory deferred data.
///
/// Backing array content hashing (for string dedup waste detection) is
/// unavailable without the file rescan. String instance counts, empty
/// collections, and boxed primitives are still reported from Phase 1 data.
pub fn parse_indexed_phase2(
    phase1: &Phase1Result,
    deferred: DeferredEdgeData,
) -> Result<Phase2Result> {
    let node_store = &phase1.node_store;
    let class_index = &phase1.class_index;
    let id_size = deferred.id_size;

    let estimated_nodes = node_store.len();
    let mut edge_builder = EdgeBuilder::with_capacity(estimated_nodes * 2);

    // Carry forward Phase 1's waste data (no backing array content available)
    let waste_data = phase1.waste_raw.clone();

    // SuperRoot -> GC root edges
    for &gc_id in &phase1.gc_root_ids {
        if let Some(root_idx) = node_store.index_of(gc_id) {
            edge_builder.add_edge(0, root_idx, label::GC_ROOT);
        }
    }

    // Instance edges from deferred data (parallel with rayon)
    let chunk_edges: Vec<Vec<(u32, u32, u8)>> = deferred.deferred_instances
        .par_chunks(10_000)
        .map(|chunk| {
            let mut local_edges = Vec::new();
            for di in chunk {
                let fields = &di.field_bytes;
                let class_obj_id = di.class_obj_id;

                if let Some(field_layout) = class_index.field_layout(class_obj_id) {
                    extract_typed_references_named(fields, id_size, field_layout, |ref_id, _fname| {
                        if let Some(ref_idx) = node_store.index_of(ref_id) {
                            local_edges.push((di.node_idx, ref_idx, label::INSTANCE_FIELD));
                        }
                    });
                } else {
                    // Fallback: brute-force reference extraction
                    extract_object_references_fallback(fields, id_size, |ref_id| {
                        if let Some(ref_idx) = node_store.index_of(ref_id) {
                            local_edges.push((di.node_idx, ref_idx, label::UNKNOWN));
                        }
                    });
                }
            }
            local_edges
        })
        .collect();

    for edges in chunk_edges {
        for (src, dst, lbl) in edges {
            edge_builder.add_edge(src, dst, lbl);
        }
    }

    // ========================================================================
    // Object array element edges (from deferred data, no file rescan needed)
    // ========================================================================

    for da in &deferred.deferred_arrays {
        for &ref_id in &da.element_refs {
            if let Some(ref_idx) = node_store.index_of(ref_id) {
                edge_builder.add_edge(da.node_idx, ref_idx, label::ARRAY_ELEMENT);
            }
        }
    }

    // ========================================================================
    // Class structural edges (from deferred data, no file rescan needed)
    // ========================================================================

    for dce in &deferred.deferred_class_edges {
        // Superclass edge
        if let Some(super_id) = dce.super_class_id {
            if let Some(super_idx) = node_store.index_of(super_id) {
                edge_builder.add_edge(dce.class_node_idx, super_idx, label::SUPER_CLASS);
            }
        }
        // Classloader edge
        if let Some(cl_id) = dce.classloader_id {
            if let Some(cl_idx) = node_store.index_of(cl_id) {
                edge_builder.add_edge(dce.class_node_idx, cl_idx, label::CLASS_LOADER);
            }
        }
        // Static field edges
        for &ref_id in &dce.static_field_refs {
            if let Some(ref_idx) = node_store.index_of(ref_id) {
                edge_builder.add_edge(dce.class_node_idx, ref_idx, label::CLASS_STATIC);
            }
        }
    }

    // ========================================================================
    // Build CSR edge store
    // ========================================================================

    let edge_store = edge_builder.build(node_store.len());

    Ok(Phase2Result {
        edge_store,
        waste_raw: waste_data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that `parse_indexed` doesn't panic on empty-ish input.
    #[test]
    fn parse_invalid_data_returns_error() {
        let result = parse_indexed(&[]);
        assert!(result.is_err());
    }

    #[test]
    fn parse_garbage_data_returns_error() {
        let result = parse_indexed(b"not a valid hprof file");
        assert!(result.is_err());
    }

    /// Verifies that the ParseResult struct can be constructed manually.
    #[test]
    fn parse_result_fields_accessible() {
        let pr = ParseResult {
            node_store: NodeStore::new(),
            edge_store: EdgeBuilder::new().build(0),
            class_index: ClassIndex::new(),
            string_table: StringTable::new(),
            gc_root_ids: Vec::new(),
            summary: HeapSummary {
                total_heap_size: 0,
                reachable_heap_size: 0,
                total_instances: 0,
                total_classes: 0,
                total_arrays: 0,
                total_gc_roots: 0,
                hprof_version: String::new(),
                heap_types: Vec::new(),
            },
            waste_raw: WasteRawData::new(),
        };

        assert_eq!(pr.node_store.len(), 0);
        assert_eq!(pr.edge_store.edge_count(), 0);
        assert_eq!(pr.class_index.len(), 0);
        assert_eq!(pr.string_table.len(), 0);
        assert!(pr.gc_root_ids.is_empty());
        assert_eq!(pr.summary.total_heap_size, 0);
    }

    /// Tests that SuperRoot is always node 0.
    #[test]
    fn super_root_is_index_zero() {
        // We can't parse a real HPROF without a file, but we can verify the
        // NodeStore logic used by parse_indexed.
        let mut ns = NodeStore::new();
        let idx = ns.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        assert_eq!(idx, 0);
        assert_eq!(ns.get_by_index(0).node_type, NodeType::SuperRoot);
    }

    /// Verifies Phase1Result and DeferredEdgeData structs can be constructed.
    #[test]
    fn phase1_result_fields_accessible() {
        let pr = Phase1Result {
            node_store: NodeStore::new(),
            class_index: ClassIndex::new(),
            string_table: StringTable::new(),
            gc_root_ids: Vec::new(),
            summary: HeapSummary {
                total_heap_size: 0,
                reachable_heap_size: 0,
                total_instances: 0,
                total_classes: 0,
                total_arrays: 0,
                total_gc_roots: 0,
                hprof_version: String::new(),
                heap_types: Vec::new(),
            },
            waste_raw: WasteRawData::new(),
            class_histogram: Vec::new(),
        };

        assert_eq!(pr.node_store.len(), 0);
        assert!(pr.class_histogram.is_empty());
        assert_eq!(pr.summary.total_heap_size, 0);
    }

    /// Verifies that parse_indexed_phase1 fails on empty input.
    #[test]
    fn parse_phase1_invalid_data_returns_error() {
        let result = parse_indexed_phase1(&[]);
        assert!(result.is_err());
    }

    /// Verifies that parse_indexed_phase1 fails on garbage input.
    #[test]
    fn parse_phase1_garbage_data_returns_error() {
        let result = parse_indexed_phase1(b"not a valid hprof file");
        assert!(result.is_err());
    }

    /// Verifies DeferredInstance is public.
    #[test]
    fn deferred_instance_is_pub() {
        let di = DeferredInstance {
            node_idx: 0,
            class_obj_id: 42,
            field_bytes: vec![1, 2, 3],
        };
        assert_eq!(di.node_idx, 0);
        assert_eq!(di.class_obj_id, 42);
        assert_eq!(di.field_bytes.len(), 3);
    }
}
