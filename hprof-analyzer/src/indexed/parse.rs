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

use crate::graph_builder::convert_jvm_class_name;
use crate::waste::{
    BackingArrayInfo, BoxedPrimitiveInfo, EmptyCollectionInfo, OverAllocatedCollectionInfo,
    StringInstanceInfo, WasteRawData,
};
use crate::HeapSummary;

use super::class_index::{ClassIndex, ClassInfo, FieldDescriptor};
#[cfg(test)]
use super::edge_store::EdgeBuilder;
use super::edge_store::EdgeStore;
use super::node_store::{NodeStore, NodeType};
use super::parse_metadata::{CandidateFields, ParseNames};
use super::string_table::StringTable;
use super::waste::{backing_array, ArrayContentRange, LazyStringContents};

/// Cached instance record for deferred edge extraction.
#[derive(Clone)]
pub struct DeferredInstance {
    /// Index of this instance in the NodeStore.
    pub node_idx: u32,
    /// Class object ID (for layout lookup).
    pub class_obj_id: u64,
    /// Borrowed-file ranges for mapped input; owned bytes for borrowed APIs.
    pub field_bytes: DeferredBytes,
}

#[derive(Clone)]
pub enum DeferredBytes {
    Owned(Vec<u8>),
    Mapped { offset: usize, length: usize },
}
impl DeferredBytes {
    fn capture(bytes: &[u8], input: &[u8], mapped: bool) -> Result<Self> {
        if !mapped {
            return Ok(Self::Owned(bytes.to_vec()));
        }
        let offset = (bytes.as_ptr() as usize)
            .checked_sub(input.as_ptr() as usize)
            .ok_or_else(|| anyhow::anyhow!("Invalid input range"))?;
        anyhow::ensure!(
            offset
                .checked_add(bytes.len())
                .is_some_and(|end| end <= input.len()),
            "Invalid input range"
        );
        Ok(Self::Mapped {
            offset,
            length: bytes.len(),
        })
    }
    pub(crate) fn bytes<'a>(&'a self, input: Option<&'a [u8]>) -> Result<&'a [u8]> {
        match self {
            Self::Owned(bytes) => Ok(bytes),
            Self::Mapped { offset, length } => input
                .and_then(|input| {
                    offset
                        .checked_add(*length)
                        .and_then(|end| input.get(*offset..end))
                })
                .ok_or_else(|| anyhow::anyhow!("Mapped input range unavailable")),
        }
    }
}

/// Cached object array element references for deferred edge extraction.
pub type DeferredObjectArray = DeferredInstance;

/// Cached class structural edges for deferred edge extraction.
pub struct DeferredClassEdge {
    /// Index of the class node in the NodeStore.
    pub class_node_idx: u32,
    /// Super class object ID (None if java.lang.Object or 0).
    pub super_class_id: Option<u64>,
    /// Classloader object ID (None if bootstrap/0).
    pub classloader_id: Option<u64>,
    pub signers_id: Option<u64>,
    pub protection_domain_id: Option<u64>,
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
    pub waste_raw: Arc<WasteRawData>,
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
    pub waste_raw: Arc<WasteRawData>,
    /// Class histogram computed from shallow sizes only.
    pub class_histogram: Vec<crate::ClassHistogramEntry>,
}

/// Data deferred from Phase 1 that Phase 2 needs for edge extraction.
pub struct DeferredEdgeData {
    /// Validated upper bound used only to select bounded in-memory staging.
    pub max_references: usize,
    pub mapping: Option<Arc<memmap2::Mmap>>,
    pub deferred_instances: super::deferred_records::DeferredRecords,
    pub deferred_arrays: super::deferred_records::DeferredRecords,
    pub deferred_class_edges: Vec<DeferredClassEdge>,
    pub class_name_map: HashMap<u64, Arc<str>>,
    pub class_instance_sizes: HashMap<u64, u64>,
    pub id_size: jvm_hprof::IdSize,
}

/// Result of Phase 2 parsing (edges + CSR).
///
/// No longer requires a file rescan — all data is collected during Phase 1.
pub struct Phase2Result {
    pub object_bodies: Option<super::object_bodies::ObjectBodies>,
    pub edge_store: EdgeStore,
    /// Waste data (backing array content hashing is unavailable without file rescan;
    /// string instance counts, empty collections, and boxed primitives are still present).
    pub waste_raw: Arc<WasteRawData>,
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
    node_store.add_node(obj_id, 0, 0, NodeType::GcRoot, Arc::from("GcRoot"));
}

/// Parses an HPROF file into indexed data structures.
///
/// This is the backward-compatible entry point that calls Phase 1 + Phase 2
/// internally and returns a complete `ParseResult`.
pub fn parse_indexed(data: &[u8]) -> Result<ParseResult> {
    parse_indexed_with_layout(data, None)
}

/// Parse using a known producer layout, or infer an estimated layout with None.
pub fn parse_indexed_with_layout(
    data: &[u8],
    layout: Option<crate::object_layout::ObjectLayout>,
) -> Result<ParseResult> {
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

pub fn parse_indexed_phase1_with_layout(
    data: &[u8],
    layout: Option<crate::object_layout::ObjectLayout>,
) -> Result<(Phase1Result, DeferredEdgeData)> {
    parse_phase1(data, layout, None, None, None, &mut |_| {})
}

/// File-backed entry point: preserve the mapping for on-demand content analysis.
/// As with HprofLoader, the input file must remain immutable while it is mapped.
pub fn parse_indexed_phase1_mapped(
    mapping: Arc<memmap2::Mmap>,
    layout: Option<crate::object_layout::ObjectLayout>,
) -> Result<(Phase1Result, DeferredEdgeData)> {
    parse_phase1(
        &mapping,
        layout,
        Some(mapping.clone()),
        None,
        None,
        &mut |_| {},
    )
}
pub fn parse_indexed_phase1_mapped_cancellable(
    mapping: Arc<memmap2::Mmap>,
    layout: Option<crate::object_layout::ObjectLayout>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(Phase1Result, DeferredEdgeData)> {
    parse_indexed_phase1_observed(mapping, layout, cancel, &mut |_| {})
}

pub fn parse_indexed_phase1_observed(
    mapping: Arc<memmap2::Mmap>,
    layout: Option<crate::object_layout::ObjectLayout>,
    cancel: &std::sync::atomic::AtomicBool,
    progress: &mut dyn FnMut(super::progress::Observation<'_>),
) -> Result<(Phase1Result, DeferredEdgeData)> {
    parse_phase1(
        &mapping,
        layout,
        Some(mapping.clone()),
        None,
        Some((0, cancel)),
        progress,
    )
}

pub(crate) fn parse_indexed_phase1_disk(
    mapping: Arc<memmap2::Mmap>,
    directory: &std::path::Path,
    sort_bytes: usize,
    cancel: &std::sync::atomic::AtomicBool,
    progress: &mut dyn FnMut(super::progress::Observation<'_>),
) -> Result<(Phase1Result, DeferredEdgeData)> {
    parse_phase1(
        &mapping,
        None,
        Some(mapping.clone()),
        Some(directory),
        Some((sort_bytes, cancel)),
        progress,
    )
}

fn parse_phase1(
    data: &[u8],
    layout: Option<crate::object_layout::ObjectLayout>,
    mapping: Option<Arc<memmap2::Mmap>>,
    directory: Option<&std::path::Path>,
    construction: Option<(usize, &std::sync::atomic::AtomicBool)>,
    progress: &mut dyn FnMut(super::progress::Observation<'_>),
) -> Result<(Phase1Result, DeferredEdgeData)> {
    let sizing_timer = super::stage_timer::StageTimer::start("parse.sizing_and_producer");
    let mut content_ranges = HashMap::new();
    let mut ids = if let (Some(directory), Some((bytes, cancel))) = (directory, construction) {
        let mut sorter = super::sorted_runs::Sorter::<u64>::new(
            directory,
            bytes.min(16 * 1024 * 1024),
            true,
            cancel,
        )?;
        sorter.push(0)?;
        Some(sorter)
    } else {
        None
    };
    let mut catalog = |id| ids.as_mut().expect("catalog enabled").push(id);
    let has_catalog = directory.is_some();
    let cancelled = || {
        construction.is_some_and(|(_, cancel)| cancel.load(std::sync::atomic::Ordering::Relaxed))
    };
    let catalog = if has_catalog {
        Some(&mut catalog as &mut dyn FnMut(u64) -> Result<()>)
    } else {
        None
    };
    let mut counts_progress = |counts: crate::hprof_sizing::RecordCounts| {
        progress(super::progress::Observation::Records {
            instances: counts.instances,
            arrays: counts.object_arrays + counts.primitive_arrays,
            classes: counts.classes,
            roots: counts.roots,
        })
    };
    let sizing = if let Some(mapping) = mapping.as_deref() {
        crate::hprof_sizing::HprofSizing::read_mapped_tracked(
            mapping,
            layout,
            &cancelled,
            catalog,
            &mut counts_progress,
        )?
    } else {
        crate::hprof_sizing::HprofSizing::read_tracked(
            data,
            layout,
            &cancelled,
            catalog,
            &mut counts_progress,
        )?
    };
    drop(sizing_timer);
    let catalog_timer = super::stage_timer::StageTimer::start("parse.catalog_and_names");
    progress(super::progress::Observation::Stage("catalog_building"));
    let hprof =
        parse_hprof(data).map_err(|e| anyhow::anyhow!("Failed to parse HPROF file: {:?}", e))?;

    let id_size = hprof.header().id_size();
    let hprof_version = hprof.header().label().unwrap_or("unknown").to_string();

    // The sizing scan already visits these records. Reuse its independent hints
    // rather than reserving object/class/string tables from payload byte size.
    // Record multiplicity is preserved; this is not a total process RAM limit.
    let counts = sizing.record_counts;
    // Admit before count-sized tables are allocated. Retain the lease with the
    // final state, including while its dump editor is open but idle.
    let resource = if mapping.is_some() {
        Some(super::resource_lease::Lease::acquire(
            super::resource_plan::Plan::from_counts(
                counts,
                directory.is_some(),
                construction.map_or(0, |(bytes, _)| bytes),
            )?,
        )?)
    } else {
        None
    };
    let mut string_table = StringTable::try_with_capacity(counts.strings)?;
    let mut load_class_entries: Vec<(u64, u64)> = reserved_records(counts.load_classes)?;
    let mut class_index = ClassIndex::try_with_capacity(counts.classes)?;
    let mut node_store = if let Some(ids) = ids {
        NodeStore::construction(ids.finish()?, directory.unwrap(), construction.unwrap().1)?
    } else {
        NodeStore::try_with_capacity(counts.node_capacity()?)?
    };
    node_store.set_resource(resource);
    let mut gc_root_ids: Vec<u64> = reserved_records(counts.roots)?;
    let mut deferred_instances = super::deferred_records::DeferredRecords::new(
        counts.instances,
        mapping.is_some(),
        directory,
    )?;
    let mut deferred_arrays = super::deferred_records::DeferredRecords::new(
        counts.object_arrays,
        mapping.is_some(),
        directory,
    )?;
    let mut deferred_class_edges: Vec<DeferredClassEdge> = reserved_records(counts.classes)?;
    let mut heap_types: Vec<String> = Vec::new();

    // Class name map: class_obj_id -> human-readable name
    let mut class_name_map =
        super::parse_metadata::prepare_class_names(data, &mut load_class_entries, || {
            construction
                .is_some_and(|(_, cancel)| cancel.load(std::sync::atomic::Ordering::Relaxed))
        })?;
    drop(catalog_timer);
    let records_timer = super::stage_timer::StageTimer::start("parse.node_records");
    let mut missing_instance_names = false;
    let mut missing_array_names = false;
    let mut names = ParseNames::new();
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

    // Counters
    let mut instance_count = 0u64;
    let mut array_count = 0u64;
    let mut class_count = 0u64;
    let mut gc_root_count = 0u64;
    let mut total_shallow_size = 0u64;

    // Add SuperRoot node at index 0
    let super_root_name: Arc<str> = Arc::from("SuperRoot");
    let _super_root_idx = node_store.add_node(0, 0, 0, NodeType::SuperRoot, super_root_name);

    // ========================================================================
    // Pass 1: Single scan of all records
    // ========================================================================

    for record_result in hprof.records_iter() {
        let record =
            record_result.map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;

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
                // Class-name headers were collected without scanning heap bodies.
            }
            RecordTag::HeapDump | RecordTag::HeapDumpSegment => {
                if let Some(hd_result) = record.as_heap_dump_segment() {
                    let heap_dump = hd_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse HeapDumpSegment: {:?}", e))?;

                    for sub_result in heap_dump.sub_records() {
                        if let Some((_, cancel)) = construction {
                            super::disk_edges::check(cancel)?;
                        }
                        let sub = sub_result
                            .map_err(|e| anyhow::anyhow!("Failed to parse sub-record: {:?}", e))?;

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

                                // A root record may precede the class definition.
                                let (class_idx, defined) = node_store.define_node(
                                    obj_id,
                                    0,
                                    NodeType::Class,
                                    Arc::from("Class"),
                                );
                                class_count += u64::from(defined);

                                // Collect class structural edges for Phase 2
                                // (target nodes may not exist yet during Phase 1)
                                {
                                    let super_class_id = class
                                        .super_class_obj_id()
                                        .map(|id| id.id())
                                        .filter(|&id| id != 0);
                                    let classloader_id = class
                                        .class_loader_obj_id()
                                        .map(|id| id.id())
                                        .filter(|&id| id != 0);

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
                                        signers_id: class
                                            .signers_obj_id()
                                            .map(|id| id.id())
                                            .filter(|&id| id != 0),
                                        protection_domain_id: class
                                            .protection_domain_obj_id()
                                            .map(|id| id.id())
                                            .filter(|&id| id != 0),
                                        static_field_refs,
                                    });
                                }
                            }

                            // ---- Instance ----
                            jvm_hprof::heap_dump::SubRecord::Instance(instance) => {
                                let obj_id = instance.obj_id().id();
                                let class_obj_id = instance.class_obj_id().id();
                                let size =
                                    sizing.instance(class_obj_id, instance.fields().len())?;
                                let class_name = class_name_map
                                    .get(&class_obj_id)
                                    .cloned()
                                    .unwrap_or_else(|| {
                                        missing_instance_names = true;
                                        names.unknown(class_obj_id)
                                    });

                                let (node_idx, defined) = node_store.define_node(
                                    obj_id,
                                    size,
                                    NodeType::Instance,
                                    class_name,
                                );
                                if defined {
                                    instance_count += 1;
                                    total_shallow_size += size as u64;
                                }

                                // Cache field bytes for deferred edge extraction
                                deferred_instances.push(DeferredInstance {
                                    node_idx,
                                    class_obj_id,
                                    field_bytes: DeferredBytes::capture(
                                        instance.fields(),
                                        data,
                                        mapping.is_some(),
                                    )?,
                                })?;
                            }

                            // ---- Object Array ----
                            jvm_hprof::heap_dump::SubRecord::ObjectArray(array) => {
                                let obj_id = array.obj_id().id();
                                let array_class_obj_id = array.array_class_obj_id().id();

                                // Use num_elements() from the HPROF header (O(1))
                                // instead of iterating to count. Still iterate
                                // for collecting non-null element references.
                                let element_count = array.num_elements();
                                let element_refs = DeferredBytes::capture(
                                    array.raw_contents(),
                                    data,
                                    mapping.is_some(),
                                )?;

                                let size = sizing.object_array(element_count)?;
                                // Use a placeholder; LoadClass may not be processed yet.
                                // Will be fixed up after class_name_map is populated.
                                let class_name = class_name_map
                                    .get(&array_class_obj_id)
                                    .cloned()
                                    .unwrap_or_else(|| {
                                        missing_array_names = true;
                                        names.object_array()
                                    });
                                array_element_counts.insert(obj_id, element_count);

                                let (node_idx, defined) = node_store.define_node(
                                    obj_id,
                                    size,
                                    NodeType::ObjectArray,
                                    class_name,
                                );
                                if defined {
                                    array_count += 1;
                                    total_shallow_size += size as u64;
                                }

                                // Track for deferred class name fixup

                                // Store element refs for deferred edge extraction in Phase 2
                                deferred_arrays.push(DeferredObjectArray {
                                    node_idx,
                                    class_obj_id: array_class_obj_id,
                                    field_bytes: element_refs,
                                })?;
                            }

                            // ---- Primitive Array ----
                            jvm_hprof::heap_dump::SubRecord::PrimitiveArray(array) => {
                                let obj_id = array.obj_id().id();
                                let prim_type = array.primitive_type();
                                // Use num_elements() from the HPROF header directly (O(1))
                                // instead of iterating all elements via typed iterators.
                                let elem_count = array.num_elements();
                                let (elem_size, class_name) = names.primitive(prim_type);

                                let size = sizing.primitive_array(elem_count, elem_size as u64)?;
                                array_element_counts.insert(obj_id, elem_count);

                                // A mapped input defers payload reads until Waste is requested.
                                if matches!(
                                    prim_type,
                                    jvm_hprof::heap_dump::PrimitiveArrayType::Byte
                                        | jvm_hprof::heap_dump::PrimitiveArrayType::Char
                                ) {
                                    let raw_data = array.contents();
                                    if !raw_data.is_empty() {
                                        let is_char = matches!(
                                            prim_type,
                                            jvm_hprof::heap_dump::PrimitiveArrayType::Char
                                        );
                                        if mapping.is_some() {
                                            let offset = (raw_data.as_ptr() as usize)
                                                .checked_sub(data.as_ptr() as usize)
                                                .ok_or_else(|| {
                                                    anyhow::anyhow!("Invalid array content range")
                                                })?;
                                            let end = offset
                                                .checked_add(raw_data.len())
                                                .filter(|end| *end <= data.len())
                                                .ok_or_else(|| {
                                                    anyhow::anyhow!("Invalid array content range")
                                                })?;
                                            content_ranges.insert(
                                                obj_id,
                                                ArrayContentRange {
                                                    offset,
                                                    length: end - offset,
                                                    shallow_size: size,
                                                    is_char,
                                                },
                                            );
                                        } else {
                                            // Borrowed-byte callers keep their established eager semantics.
                                            backing_arrays.insert(
                                                obj_id,
                                                backing_array(raw_data, size, is_char),
                                            );
                                        }
                                    }
                                }

                                let (_, defined) = node_store.define_node(
                                    obj_id,
                                    size,
                                    NodeType::PrimitiveArray,
                                    class_name,
                                );
                                if defined {
                                    array_count += 1;
                                    total_shallow_size += size as u64;
                                }
                            }

                            // ---- PrimitiveArrayNoData (Android) ----
                            jvm_hprof::heap_dump::SubRecord::PrimitiveArrayNoData(array) => {
                                let obj_id = array.obj_id().id();
                                let prim_type = array.primitive_type();
                                let (_, class_name) = names.primitive(prim_type);

                                let (_, defined) = node_store.define_node(
                                    obj_id,
                                    0,
                                    NodeType::PrimitiveArray,
                                    class_name,
                                );
                                if defined {
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

    drop(records_timer);
    let metadata_timer = super::stage_timer::StageTimer::start("parse.metadata_fixups");
    for &(class_obj_id, class_name_id) in &load_class_entries {
        if let Some(name) = string_table.get(class_name_id) {
            let java_name = convert_jvm_class_name(name);
            let arc_name: Arc<str> = class_name_map
                .get(&class_obj_id)
                .filter(|name| name.as_ref() == java_name)
                .cloned()
                .unwrap_or_else(|| Arc::from(java_name.as_str()));
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

    deferred_instances.finish()?;
    deferred_arrays.finish()?;

    node_store.validate_construction()?;

    // Fix up Class node names (they were stored as "Class" placeholder
    // because LoadClass may not have been processed yet)
    for &(id, _) in &load_class_entries {
        let Some(index) = node_store.index_of(id) else {
            continue;
        };
        let node = node_store.get_by_index(index);
        if matches!(node.node_type, NodeType::Class) && node.class_name.as_ref() == "Class" {
            if let Some(name) = class_name_map.get(&node.id) {
                let mut node_mut = node_store.get_by_index_mut(index);
                node_mut.class_name = Arc::from(format!("class {}", name.as_ref()));
            }
        }
    }

    // Fix up deferred instance class names (instances whose class was Unknown
    // because LoadClass hadn't been processed yet)
    if missing_instance_names {
        for di in deferred_instances.iter() {
            if let Some(name) = class_name_map.get(&di.class_obj_id) {
                let node = node_store.get_by_index(di.node_idx);
                if node.class_name.starts_with("Unknown(") {
                    let mut node_mut = node_store.get_by_index_mut(di.node_idx);
                    node_mut.class_name = name.clone();
                }
            }
        }
    }

    // Fix up object array class names (arrays whose class name defaulted to
    // "Object[]" because LoadClass hadn't been processed yet)
    if missing_array_names {
        for array in deferred_arrays.iter() {
            let (node_idx, array_class_obj_id) = (array.node_idx, array.class_obj_id);
            if let Some(name) = class_name_map.get(&array_class_obj_id) {
                let node = node_store.get_by_index(node_idx);
                if node.class_name.as_ref() == "Object[]" {
                    let mut node_mut = node_store.get_by_index_mut(node_idx);
                    node_mut.class_name = name.clone();
                }
            }
        }
    }

    // ========================================================================
    // Resolve class field layouts
    // ========================================================================

    class_index.resolve_field_layouts();
    drop(field_name_intern);
    drop(names);
    drop(metadata_timer);

    // ========================================================================
    // Build class histogram from shallow sizes (no retained sizes yet)
    // ========================================================================

    let histogram_timer = super::stage_timer::StageTimer::start("parse.shallow_histogram");
    let class_histogram =
        super::parse_metadata::shallow_histogram_cancellable(&node_store, &mut || {
            construction
                .is_some_and(|(_, cancel)| cancel.load(std::sync::atomic::Ordering::Relaxed))
        })?;
    drop(histogram_timer);

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
    progress(super::progress::Observation::Shallow {
        summary: &summary,
        histogram: &class_histogram,
    });
    let waste_timer = super::stage_timer::StageTimer::start("parse.waste_candidates");

    // ========================================================================
    // Build waste_raw with array_element_counts (Phase 1 portion)
    // ========================================================================

    let mut waste_raw = WasteRawData::new();
    waste_raw.reference_bytes = sizing.layout.reference_bytes();
    waste_raw.lazy_contents = mapping
        .as_ref()
        .map(|mapping| Arc::new(LazyStringContents::new(mapping.clone(), content_ranges)));
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

        let candidate_fields: HashMap<u64, CandidateFields> = [
            string_class_id,
            hashmap_class_id,
            linked_hashmap_class_id,
            arraylist_class_id,
        ]
        .into_iter()
        .flatten()
        .filter_map(|id| {
            class_index
                .field_layout(id)
                .map(|layout| (id, CandidateFields::new(layout, id_size)))
        })
        .collect();

        waste_raw.array_element_counts = array_element_counts;

        for di in deferred_instances.iter() {
            let class_obj_id = di.class_obj_id;

            if let Some(plan) = candidate_fields.get(&class_obj_id) {
                let fields = di.field_bytes.bytes(Some(data))?;

                // Waste: String value references
                if string_class_id == Some(class_obj_id) {
                    if let Some(value_array_id) = plan.object(fields) {
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
                    if let Some(size_val) = plan.int(fields) {
                        let cname = class_name_map
                            .get(&class_obj_id)
                            .cloned()
                            .unwrap_or_default();
                        let shallow = sizing.instance(class_obj_id, fields.len())?;
                        if size_val == 0 {
                            waste_raw.empty_collections.push(EmptyCollectionInfo {
                                class_name: cname,
                                shallow_size: shallow,
                            });
                        } else if let Some(backing_array_id) = plan.object(fields) {
                            if let Some(capacity) =
                                waste_raw.array_count(backing_array_id)
                            {
                                let size_u32 = size_val as u32;
                                if capacity > 4 * size_u32 && capacity > 16 {
                                    waste_raw.over_allocated_collections.push(
                                        OverAllocatedCollectionInfo {
                                            class_name: cname,
                                            size: size_u32,
                                            capacity,
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }

            // Waste: boxed primitives (outside field_layout check —
            // boxed primitives may not have field layouts resolved)
            if let Some(&(bp_name, _prim_size)) = boxed_ids.get(&class_obj_id) {
                let fields = di.field_bytes.bytes(Some(data))?;
                let shallow = sizing.instance(class_obj_id, fields.len())?;
                waste_raw.boxed_primitives.push(BoxedPrimitiveInfo {
                    class_name: Arc::from(bp_name),
                    shallow_size: shallow,
                });
            }
        }
    }

    drop(waste_timer);
    let deferred = DeferredEdgeData {
        max_references: counts.reference_capacity()?,
        mapping,
        deferred_instances,
        deferred_arrays,
        deferred_class_edges,
        class_name_map,
        class_instance_sizes,
        id_size,
    };

    let phase1 = Phase1Result {
        node_store,
        class_index,
        string_table,
        gc_root_ids,
        classloader_ids,
        summary,
        waste_raw: Arc::new(waste_raw),
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
    parse_indexed_phase2_cancellable(phase1, deferred, &std::sync::atomic::AtomicBool::new(false))
}
pub fn parse_indexed_phase2_cancellable(
    phase1: &Phase1Result,
    deferred: DeferredEdgeData,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Phase2Result> {
    let edges = super::memory_edges::build(phase1, &deferred, cancel)?;
    Ok(Phase2Result {
        object_bodies: deferred
            .mapping
            .as_ref()
            .map(|_| {
                super::object_bodies::ObjectBodies::memory_catalog(&deferred.deferred_instances)
            })
            .transpose()?,
        edge_store: edges,
        waste_raw: phase1.waste_raw.clone(),
    })
}

/// Disk mode streams each resolved reference into a bounded sorted-run builder.
pub fn parse_indexed_phase2_disk(
    phase1: &Phase1Result,
    deferred: DeferredEdgeData,
    directory: &std::path::Path,
    edge_buffer_bytes: usize,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Phase2Result> {
    Ok(
        parse_indexed_phase2_disk_recorded(phase1, deferred, directory, edge_buffer_bytes, cancel)?
            .0,
    )
}

pub(crate) fn parse_indexed_phase2_disk_recorded(
    phase1: &Phase1Result,
    mut deferred: DeferredEdgeData,
    directory: &std::path::Path,
    edge_buffer_bytes: usize,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(Phase2Result, Vec<super::cache_writer::Receipt>)> {
    let mut batch = super::reference_batch::ReferenceBatch::new(edge_buffer_bytes)?;
    let mut builder = super::disk_edges::DiskEdgeBuilder::new(
        directory,
        phase1.node_store.len(),
        edge_buffer_bytes - batch.bytes(),
        cancel,
    )?;
    let timer = super::stage_timer::StageTimer::start("disk.reference_extraction");
    for instance in deferred.deferred_instances.iter() {
        super::disk_edges::check(cancel)?;
        super::edge_extract::instance_reference_ids(
            &instance,
            &deferred,
            phase1,
            |src, id, label| {
                batch.push(src, id, label, &phase1.node_store, |s, t, l| {
                    builder.add_edge(s, t, l)
                })
            },
        )?;
    }
    batch.flush(&phase1.node_store, |s, t, l| builder.add_edge(s, t, l))?;
    drop(batch);
    super::edge_extract::structural(&deferred, phase1, |src, dst, label| {
        builder.add_edge(src, dst, label)
    })?;
    drop(timer);
    let body_receipt = super::object_bodies::ObjectBodies::write_catalog(
        &mut deferred.deferred_instances,
        directory,
        edge_buffer_bytes.min(16 * 1024 * 1024),
        cancel,
    )?;
    let input_bytes = deferred
        .mapping
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Disk storage requires mapped input"))?
        .len();
    // References and body offsets are now persisted. Free parse-only records
    // before reverse sorting, mapping and cache publication can overlap them.
    drop(deferred);
    let bodies =
        super::object_bodies::ObjectBodies::map_cancellable(directory, phase1.node_store.len(), input_bytes, cancel)?;
    let (edge_store, mut receipts) = builder.build_recorded()?;
    receipts.push(body_receipt);
    Ok((
        Phase2Result {
            object_bodies: Some(bodies),
            edge_store,
            waste_raw: phase1.waste_raw.clone(),
        },
        receipts,
    ))
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
            waste_raw: WasteRawData::new().into(),
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
            waste_raw: WasteRawData::new().into(),
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
            waste_raw: WasteRawData::new().into(),
            class_histogram: Vec::new(),
        };
        let deferred = DeferredEdgeData {
            max_references: usize::MAX,
            mapping: None,
            deferred_instances: vec![DeferredInstance {
                node_idx: reference_idx,
                class_obj_id: 11,
                field_bytes: DeferredBytes::Owned(200u64.to_be_bytes().to_vec()),
            }]
            .into(),
            deferred_arrays: Vec::new().into(),
            deferred_class_edges: Vec::new(),
            class_name_map: HashMap::new(),
            class_instance_sizes: HashMap::new(),
            id_size: jvm_hprof::IdSize::U64,
        };

        let phase2 = parse_indexed_phase2(&phase1, deferred).unwrap();

        assert!(
            !phase2
                .edge_store
                .neighbors(reference_idx)
                .contains(&payload_idx),
            "java.lang.ref.Reference.referent must not keep its target strongly reachable"
        );
    }
}
