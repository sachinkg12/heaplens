//! Single-pass HPROF parser producing indexed data structures.
//!
//! Replaces the multi-pass `build_graph` function in `lib.rs` with a
//! streamlined parser that collects all data in one file scan, then
//! resolves class field layouts and extracts edges in a second
//! in-memory pass over cached instance data.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use jvm_hprof::{parse_hprof, RecordTag};
use rayon::prelude::*;

use crate::graph_builder::{convert_jvm_class_name, types_only};
use crate::waste::{
    extract_nth_field_of_type,
    BackingArrayInfo, BoxedPrimitiveInfo, EmptyCollectionInfo,
    OverAllocatedCollectionInfo, StringInstanceInfo, WasteRawData,
};
use crate::HeapSummary;

use super::class_index::{ClassIndex, ClassInfo, FieldDescriptor};
use super::edge_store::{EdgeBuilder, EdgeStore};
use super::node_store::{NodeStore, NodeType};
use super::string_table::StringTable;
use super::waste::{backing_array, ArrayContentRange, LazyStringContents};

/// Cached instance record for deferred edge extraction.
pub struct DeferredInstance {
    /// Index of this instance in the NodeStore.
    pub node_idx: u32,
    /// Class object ID (for layout lookup).
    pub class_obj_id: u64,
    /// Borrowed-file ranges for mapped input; owned bytes for borrowed APIs.
    pub field_bytes: DeferredBytes,
}

pub enum DeferredBytes {
    Owned(Vec<u8>),
    Mapped { offset: usize, length: usize },
}
impl DeferredBytes {
    fn capture(bytes: &[u8], input: &[u8], mapped: bool) -> Result<Self> {
        if !mapped { return Ok(Self::Owned(bytes.to_vec())); }
        let offset = (bytes.as_ptr() as usize).checked_sub(input.as_ptr() as usize)
            .ok_or_else(|| anyhow::anyhow!("Invalid input range"))?;
        anyhow::ensure!(offset.checked_add(bytes.len()).is_some_and(|end| end <= input.len()), "Invalid input range");
        Ok(Self::Mapped { offset, length: bytes.len() })
    }
    pub(crate) fn bytes<'a>(&'a self, input: Option<&'a [u8]>) -> Result<&'a [u8]> {
        match self {
            Self::Owned(bytes) => Ok(bytes),
            Self::Mapped { offset, length } => input.and_then(|input| offset.checked_add(*length).and_then(|end| input.get(*offset..end)))
                .ok_or_else(|| anyhow::anyhow!("Mapped input range unavailable")),
        }
    }
}

/// Cached object array element references for deferred edge extraction.
pub struct DeferredObjectArray {
    /// Index of the array node in the NodeStore.
    pub node_idx: u32,
    /// Encoded array IDs; nulls are skipped during edge extraction.
    pub element_refs: DeferredBytes,
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
    /// Object IDs used as classloaders by one or more class definitions.
    pub classloader_ids: std::collections::HashSet<u64>,
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
    /// Object IDs used as classloaders by one or more class definitions.
    pub classloader_ids: std::collections::HashSet<u64>,
    pub summary: HeapSummary,
    pub waste_raw: WasteRawData,
    /// Class histogram computed from shallow sizes only.
    pub class_histogram: Vec<crate::ClassHistogramEntry>,
}

/// Data deferred from Phase 1 that Phase 2 needs for edge extraction.
pub struct DeferredEdgeData {
    pub mapping: Option<Arc<memmap2::Mmap>>,
    pub deferred_instances: Vec<DeferredInstance>,
    pub deferred_arrays: Vec<DeferredObjectArray>,
    pub deferred_class_edges: Vec<DeferredClassEdge>,
    pub class_name_map: HashMap<u64, Arc<str>>,
    pub class_instance_sizes: HashMap<u64, u64>,
    pub id_size: jvm_hprof::IdSize,
    pub array_element_counts: HashMap<u64, u32>,
}

/// Result of Phase 2 parsing (edges + CSR).
///
/// No longer requires a file rescan — all data is collected during Phase 1.
pub struct Phase2Result {
    pub object_bodies: Option<super::object_bodies::ObjectBodies>,
    pub edge_store: EdgeStore,
    /// Waste data (backing array content hashing is unavailable without file rescan;
    /// string instance counts, empty collections, and boxed primitives are still present).
    pub waste_raw: WasteRawData,
}

fn reserved_records<T>(capacity: usize) -> Result<Vec<T>> {
    let mut records = Vec::new();
    records.try_reserve_exact(capacity)?;
    Ok(records)
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
    parse_indexed_with_layout(data, None)
}

/// Parse using a known producer layout, or infer an estimated layout with None.
pub fn parse_indexed_with_layout(data: &[u8], layout: Option<crate::object_layout::ObjectLayout>) -> Result<ParseResult> {
    let (phase1, deferred) = parse_indexed_phase1_with_layout(data, layout)?;
    let phase2 = parse_indexed_phase2(&phase1, deferred)?;

    Ok(ParseResult {
        node_store: phase1.node_store,
        edge_store: phase2.edge_store,
        class_index: phase1.class_index,
        string_table: phase1.string_table,
        gc_root_ids: phase1.gc_root_ids,
        classloader_ids: phase1.classloader_ids,
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
    parse_indexed_phase1_with_layout(data, None)
}

pub fn parse_indexed_phase1_with_layout(data: &[u8], layout: Option<crate::object_layout::ObjectLayout>) -> Result<(Phase1Result, DeferredEdgeData)> {
    parse_phase1(data, layout, None)
}

/// File-backed entry point: preserve the mapping for on-demand content analysis.
/// As with HprofLoader, the input file must remain immutable while it is mapped.
pub fn parse_indexed_phase1_mapped(mapping: Arc<memmap2::Mmap>, layout: Option<crate::object_layout::ObjectLayout>) -> Result<(Phase1Result, DeferredEdgeData)> {
    parse_phase1(&mapping, layout, Some(mapping.clone()))
}

fn parse_phase1(data: &[u8], layout: Option<crate::object_layout::ObjectLayout>, mapping: Option<Arc<memmap2::Mmap>>) -> Result<(Phase1Result, DeferredEdgeData)> {
    let mut content_ranges = HashMap::new();
    let sizing = crate::hprof_sizing::HprofSizing::read(data, layout)?;
    let hprof = parse_hprof(data)
        .map_err(|e| anyhow::anyhow!("Failed to parse HPROF file: {:?}", e))?;

    let id_size = hprof.header().id_size();
    let hprof_version = hprof
        .header()
        .label()
        .unwrap_or("unknown")
        .to_string();

    // The sizing scan already visits these records. Reuse its independent hints
    // rather than reserving object/class/string tables from payload byte size.
    // Record multiplicity is preserved; this is not a total process RAM limit.
    let counts = sizing.record_counts;
    let mut string_table = StringTable::try_with_capacity(counts.strings)?;
    let mut load_class_entries: Vec<(u64, u64)> = reserved_records(counts.load_classes)?;
    let mut class_index = ClassIndex::try_with_capacity(counts.classes)?;
    let mut node_store = NodeStore::try_with_capacity(counts.node_capacity()?)?;
    let mut gc_root_ids: Vec<u64> = reserved_records(counts.roots)?;
    let mut deferred_instances: Vec<DeferredInstance> = reserved_records(counts.instances)?;
    let mut deferred_arrays: Vec<DeferredObjectArray> = reserved_records(counts.object_arrays)?;
    let mut deferred_class_edges: Vec<DeferredClassEdge> = reserved_records(counts.classes)?;
    let mut heap_types: Vec<String> = Vec::new();

    // Class name map: class_obj_id -> human-readable name
    let mut class_name_map: HashMap<u64, Arc<str>> = HashMap::new();
    class_name_map.try_reserve(counts.load_classes)?;
    // Instance sizes from ClassDump records
    let class_instance_sizes = sizing.class_sizes.clone();
    // Field name intern pool
    let mut field_name_intern: HashMap<u64, Arc<str>> = HashMap::new();
    // Classloader IDs
    let mut classloader_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Array element counts for waste analysis
    let mut array_element_counts: HashMap<u64, u32> = HashMap::new();

    // Backing array info for string dedup waste analysis (byte[] and char[] content hashes)
    let mut backing_arrays: HashMap<u64, BackingArrayInfo> = HashMap::new();

    // Track object array node indices to their array_class_obj_id for deferred name fixup
    let mut object_array_class_ids: Vec<(u32, u64)> = reserved_records(counts.object_arrays)?;

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

                        if let Some(root_id) = crate::gc_roots::object_id(&sub) {
                            add_gc_root(
                                root_id,
                                &mut gc_root_ids,
                                &mut gc_root_count,
                                &mut node_store,
                            );
                            continue;
                        }

                        match sub {
                            // ---- ClassDump: collect metadata ----
                            jvm_hprof::heap_dump::SubRecord::Class(class) => {
                                let obj_id = class.obj_id().id();
                                let instance_size = class.instance_size_bytes();

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

                            // ---- Instance ----
                            jvm_hprof::heap_dump::SubRecord::Instance(instance) => {
                                let obj_id = instance.obj_id().id();
                                let class_obj_id = instance.class_obj_id().id();
                                let size = sizing.instance(class_obj_id, instance.fields().len())?;
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
                                    field_bytes: DeferredBytes::capture(instance.fields(), data, mapping.is_some())?,
                                });
                            }

                            // ---- Object Array ----
                            jvm_hprof::heap_dump::SubRecord::ObjectArray(array) => {
                                let obj_id = array.obj_id().id();
                                let array_class_obj_id = array.array_class_obj_id().id();

                                // Use num_elements() from the HPROF header (O(1))
                                // instead of iterating to count. Still iterate
                                // for collecting non-null element references.
                                let element_count = array.num_elements();
                                let element_refs = DeferredBytes::capture(array.raw_contents(), data, mapping.is_some())?;

                                let size = sizing.object_array(element_count)?;
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
                                if element_count != 0 {
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

                                let size = sizing.primitive_array(elem_count, elem_size as u64)?;
                                array_element_counts.insert(obj_id, elem_count);

                                // A mapped input defers payload reads until Waste is requested.
                                if matches!(prim_type,
                                    jvm_hprof::heap_dump::PrimitiveArrayType::Byte |
                                    jvm_hprof::heap_dump::PrimitiveArrayType::Char
                                ) {
                                    let raw_data = array.contents();
                                    if !raw_data.is_empty() {
                                        let is_char = matches!(prim_type, jvm_hprof::heap_dump::PrimitiveArrayType::Char);
                                        if mapping.is_some() {
                                            let offset = (raw_data.as_ptr() as usize).checked_sub(data.as_ptr() as usize)
                                                .ok_or_else(|| anyhow::anyhow!("Invalid array content range"))?;
                                            let end = offset.checked_add(raw_data.len())
                                                .filter(|end| *end <= data.len())
                                                .ok_or_else(|| anyhow::anyhow!("Invalid array content range"))?;
                                            content_ranges.insert(obj_id, ArrayContentRange {
                                                offset, length: end - offset, shallow_size: size, is_char,
                                            });
                                        } else {
                                            // Borrowed-byte callers keep their established eager semantics.
                                            backing_arrays.insert(obj_id, backing_array(raw_data, size, is_char));
                                        }
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
    waste_raw.reference_bytes = sizing.layout.reference_bytes();
    waste_raw.lazy_contents = mapping.as_ref().map(|mapping| Arc::new(LazyStringContents::new(mapping.clone(), content_ranges)));
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
            let fields = di.field_bytes.bytes(Some(data))?;
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
                            let shallow = sizing.instance(class_obj_id, fields.len())?;
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
                        let shallow = sizing.instance(class_obj_id, fields.len())?;
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
                let shallow = sizing.instance(class_obj_id, fields.len())?;
                waste_raw.boxed_primitives.push(BoxedPrimitiveInfo {
                    class_name: bp_name.to_string(),
                    shallow_size: shallow,
                });
            }
        }
    }

    let summary = HeapSummary {
        size_model: Some(sizing.metadata.clone()),
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
        mapping,
        deferred_instances,
        deferred_arrays,
        deferred_class_edges,
        class_name_map,
        class_instance_sizes,
        id_size,
        array_element_counts,
    };

    let phase1 = Phase1Result {
        node_store,
        class_index,
        string_table,
        gc_root_ids,
        classloader_ids,
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
    let mut builder = EdgeBuilder::with_capacity(phase1.node_store.len() * 2);
    let chunks: Result<Vec<Vec<(u32, u32, u8)>>> = deferred.deferred_instances
        .par_chunks(10_000).map(|chunk| {
            let mut edges = Vec::new();
            for instance in chunk {
                super::edge_extract::instance(instance, &deferred, phase1, |src, dst, label| {
                    edges.push((src, dst, label)); Ok(())
                })?;
            }
            Ok(edges)
        }).collect();
    for edges in chunks? { for (src, dst, label) in edges { builder.add_edge(src, dst, label); } }
    super::edge_extract::structural(&deferred, phase1, |src, dst, label| {
        builder.add_edge(src, dst, label); Ok(())
    })?;
    Ok(Phase2Result { object_bodies: deferred.mapping.as_ref().map(|_| super::object_bodies::ObjectBodies::memory(&deferred.deferred_instances)).transpose()?, edge_store: builder.build(phase1.node_store.len()), waste_raw: phase1.waste_raw.clone() })
}

/// Disk mode streams each resolved reference into a bounded sorted-run builder.
pub fn parse_indexed_phase2_disk(
    phase1: &Phase1Result,
    deferred: DeferredEdgeData,
    directory: &std::path::Path,
    edge_buffer_bytes: usize,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Phase2Result> {
    Ok(parse_indexed_phase2_disk_recorded(phase1, deferred, directory, edge_buffer_bytes, cancel)?.0)
}

pub(crate) fn parse_indexed_phase2_disk_recorded(
    phase1: &Phase1Result,
    mut deferred: DeferredEdgeData,
    directory: &std::path::Path,
    edge_buffer_bytes: usize,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(Phase2Result, Vec<super::cache_writer::Receipt>)> {
    let mut builder = super::disk_edges::DiskEdgeBuilder::new(directory, phase1.node_store.len(), edge_buffer_bytes, cancel)?;
    for instance in &deferred.deferred_instances {
        super::disk_edges::check(cancel)?;
        super::edge_extract::instance(instance, &deferred, phase1, |src, dst, label| builder.add_edge(src, dst, label))?;
    }
    super::edge_extract::structural(&deferred, phase1, |src, dst, label| builder.add_edge(src, dst, label))?;
    let body_receipt = super::object_bodies::ObjectBodies::write_records(&mut deferred.deferred_instances,directory,cancel)?;
    let input_bytes = deferred.mapping.as_ref().ok_or_else(||anyhow::anyhow!("Disk storage requires mapped input"))?.len();
    // References and body offsets are now persisted. Free parse-only records
    // before reverse sorting, mapping and cache publication can overlap them.
    drop(deferred);
    let bodies=super::object_bodies::ObjectBodies::map(directory,phase1.node_store.len(),input_bytes)?;
    let (edge_store, mut receipts) = builder.build_recorded()?;
    receipts.push(body_receipt);
    Ok((Phase2Result { object_bodies: Some(bodies), edge_store, waste_raw: phase1.waste_raw.clone() }, receipts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jvm_hprof::heap_dump::FieldType;

    #[test]
    fn impossible_record_reservations_return_errors_without_panicking() {
        assert!(reserved_records::<u64>(usize::MAX).is_err());
        assert!(NodeStore::try_with_capacity(usize::MAX).is_err());
        assert!(ClassIndex::try_with_capacity(usize::MAX).is_err());
        assert!(StringTable::try_with_capacity(usize::MAX).is_err());
    }

    #[test]
    fn counted_reservations_keep_duplicate_roots_and_array_records() {
        let bytes = crate::hprof_sizing::tests::count_fixture_32(0);
        let (phase, deferred) = parse_indexed_phase1(&bytes).unwrap();
        assert_eq!(phase.node_store.len(), 6);
        assert_eq!(phase.gc_root_ids, vec![20, 20]);
        assert_eq!(phase.summary.total_gc_roots, 2);
        assert_eq!(phase.summary.total_instances, 1);
        assert_eq!(phase.summary.total_arrays, 3);
        assert_eq!(deferred.deferred_instances.len(), 1);
        assert_eq!(deferred.deferred_arrays.len(), 1);
        assert_eq!(deferred.deferred_class_edges.len(), 1);
        assert_eq!(deferred.deferred_instances.capacity(), 1);
        assert_eq!(deferred.deferred_arrays.capacity(), 1);
        assert_eq!(deferred.deferred_class_edges.capacity(), 1);
    }

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
            classloader_ids: std::collections::HashSet::new(),
            summary: HeapSummary {
                total_heap_size: 0,
                reachable_heap_size: 0,
                total_instances: 0,
                total_classes: 0,
                total_arrays: 0,
                total_gc_roots: 0,
                hprof_version: String::new(),
                heap_types: Vec::new(),
                size_model: None,
            },
            waste_raw: WasteRawData::new(),
        };

        assert_eq!(pr.node_store.len(), 0);
        assert_eq!(pr.edge_store.edge_count(), 0);
        assert_eq!(pr.class_index.len(), 0);
        assert_eq!(pr.string_table.len(), 0);
        assert!(pr.gc_root_ids.is_empty());
        assert!(pr.classloader_ids.is_empty());
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
            classloader_ids: std::collections::HashSet::new(),
            summary: HeapSummary {
                total_heap_size: 0,
                reachable_heap_size: 0,
                total_instances: 0,
                total_classes: 0,
                total_arrays: 0,
                total_gc_roots: 0,
                hprof_version: String::new(),
                heap_types: Vec::new(),
                size_model: None,
            },
            waste_raw: WasteRawData::new(),
            class_histogram: Vec::new(),
        };

        assert_eq!(pr.node_store.len(), 0);
        assert!(pr.class_histogram.is_empty());
        assert!(pr.classloader_ids.is_empty());
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
            field_bytes: DeferredBytes::Owned(vec![1, 2, 3]),
        };
        assert_eq!(di.node_idx, 0);
        assert_eq!(di.class_obj_id, 42);
        assert_eq!(di.field_bytes.bytes(None).unwrap().len(), 3);
    }

    #[test]
    fn reference_referent_is_not_a_strong_graph_edge() {
        let mut class_index = ClassIndex::new();
        class_index.insert(
            10,
            ClassInfo {
                class_name: Arc::from("java.lang.ref.Reference"),
                instance_size: 16,
                super_class_id: None,
                field_descriptors: vec![FieldDescriptor {
                    name: Arc::from("referent"),
                    field_type: FieldType::ObjectId,
                }],
            },
        );
        class_index.insert(
            11,
            ClassInfo {
                class_name: Arc::from("java.lang.ref.WeakReference"),
                instance_size: 16,
                super_class_id: Some(10),
                field_descriptors: Vec::new(),
            },
        );
        class_index.resolve_field_layouts();

        let mut node_store = NodeStore::new();
        node_store.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        let reference_idx = node_store.add_node(
            100,
            0,
            16,
            NodeType::Instance,
            Arc::from("java.lang.ref.WeakReference"),
        );
        let payload_idx = node_store.add_node(
            200,
            0,
            1024,
            NodeType::Instance,
            Arc::from("example.Payload"),
        );

        let phase1 = Phase1Result {
            node_store,
            class_index,
            string_table: StringTable::new(),
            gc_root_ids: vec![100],
            classloader_ids: std::collections::HashSet::new(),
            summary: HeapSummary {
                total_heap_size: 1040,
                reachable_heap_size: 1040,
                total_instances: 2,
                total_classes: 2,
                total_arrays: 0,
                total_gc_roots: 1,
                hprof_version: String::new(),
                heap_types: Vec::new(),
                size_model: None,
            },
            waste_raw: WasteRawData::new(),
            class_histogram: Vec::new(),
        };
        let deferred = DeferredEdgeData {
            mapping: None,
            deferred_instances: vec![DeferredInstance {
                node_idx: reference_idx,
                class_obj_id: 11,
                field_bytes: DeferredBytes::Owned(200u64.to_be_bytes().to_vec()),
            }],
            deferred_arrays: Vec::new(),
            deferred_class_edges: Vec::new(),
            class_name_map: HashMap::new(),
            class_instance_sizes: HashMap::new(),
            id_size: jvm_hprof::IdSize::U64,
            array_element_counts: HashMap::new(),
        };

        let phase2 = parse_indexed_phase2(&phase1, deferred).unwrap();

        assert!(
            !phase2.edge_store.neighbors(reference_idx).contains(&payload_idx),
            "java.lang.ref.Reference.referent must not keep its target strongly reachable"
        );
    }
}
