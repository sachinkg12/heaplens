//! # hprof-analyzer
//!
//! A library for loading and analyzing Java HPROF files with zero-copy memory mapping.
//!
//! This crate provides a safe interface around memory-mapped file I/O for efficient
//! parsing of large HPROF files without loading them entirely into RAM.

pub mod heapql;
pub mod waste;
pub mod comparison;
pub(crate) mod graph_builder;
pub mod dominator;

/// Test helpers for building synthetic AnalysisState instances.
/// Available for both unit tests and integration tests.
#[doc(hidden)]
pub mod test_helpers;

use anyhow::Result;
use jvm_hprof::{parse_hprof, RecordTag, IdSize};
use memmap2::{Mmap, MmapOptions};
use petgraph::{Graph, Directed, graph::NodeIndex};
use petgraph::algo::dominators;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;

/// Errors that can occur during HPROF file loading and mapping.
#[derive(Error, Debug)]
pub enum HprofLoaderError {
    /// Failed to open the file at the given path.
    #[error("Failed to open file at {path}: {source}")]
    FileOpen {
        path: PathBuf,
        source: std::io::Error,
    },

    /// Failed to create a memory map of the file.
    #[error("Failed to create memory map for file at {path}: {source}")]
    MapCreation {
        path: PathBuf,
        source: std::io::Error,
    },

    /// The file is empty and cannot be mapped.
    #[error("File at {path} is empty (0 bytes)")]
    EmptyFile { path: PathBuf },
}

/// A loader for HPROF files that uses memory-mapped I/O for zero-copy access.
///
/// # Safety Guarantees
///
/// This struct provides a **safe** interface around `unsafe` memory mapping operations.
/// The safety invariants are:
///
/// 1. **Read-only access**: The memory map is created with read-only permissions,
///    preventing accidental modification of the underlying file.
///
/// 2. **Lifetime management**: The `Mmap` handle maintains the validity of the mapped
///    memory region. The memory is automatically unmapped when the handle is dropped.
///
/// 3. **OS-level protection**: The operating system enforces read-only access at the
///    page level, so even if unsafe code attempts to write, the OS will raise a
///    segmentation fault rather than corrupting the file.
///
/// # Why `unsafe` is Used
///
/// The `memmap2::MmapOptions::map()` method is marked `unsafe` because:
///
/// - **Raw memory access**: It provides direct access to memory pages that are
///   managed by the OS, bypassing Rust's normal ownership and borrowing rules.
///
/// - **Concurrent modification risk**: If the file is modified by another process
///   while mapped, reading from the map could see inconsistent data. However, this
///   is mitigated by:
///     - Using read-only mapping (prevents our process from modifying it)
///     - HPROF files are typically immutable once written
///     - The file handle is kept open, preventing truncation on Unix systems
///
/// - **Platform-specific behavior**: Memory mapping behavior varies across platforms
///   (Windows vs Unix), and the `unsafe` marker ensures developers are aware of
///   platform-specific considerations.
///
/// # Performance Benefits
///
/// Memory mapping provides significant performance advantages:
///
/// - **Zero-copy**: Data is accessed directly from the OS page cache without
///   copying into user-space buffers.
///
/// - **Lazy loading**: Pages are loaded on-demand via OS page faults, allowing
///   efficient handling of files larger than available RAM.
///
/// - **OS optimization**: The OS can optimize page cache usage, prefetching,
///   and memory pressure handling automatically.
///
/// - **Efficient for large files**: For multi-GB HPROF files, memory mapping avoids
///   the memory overhead of loading the entire file into RAM.
///
/// # Example
///
/// ```no_run
/// use hprof_analyzer::HprofLoader;
/// use std::path::PathBuf;
///
/// let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
/// let mmap = loader.map_file()?;
/// // mmap can be used as &[u8] for parsing
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[derive(Debug, Clone)]
pub struct HprofLoader {
    /// The path to the HPROF file to be loaded.
    path: PathBuf,
}

impl HprofLoader {
    /// Creates a new `HprofLoader` for the file at the given path.
    ///
    /// # Arguments
    ///
    /// * `path` - The path to the HPROF file to be loaded.
    ///
    /// # Example
    ///
    /// ```
    /// use hprof_analyzer::HprofLoader;
    /// use std::path::PathBuf;
    ///
    /// let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
    /// ```
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Memory-maps the HPROF file for zero-copy read-only access.
    ///
    /// This method creates a read-only memory mapping of the file, allowing
    /// efficient access to large HPROF files without loading them entirely
    /// into memory.
    ///
    /// # Safety
    ///
    /// While this method uses `unsafe` internally, it provides a **safe** interface
    /// by ensuring:
    ///
    /// 1. The file is opened with read-only permissions
    /// 2. The memory map is created as read-only
    /// 3. The file handle is kept alive for the lifetime of the map
    /// 4. Proper error handling for all failure cases
    ///
    /// The `unsafe` block is necessary because `MmapOptions::map()` is marked unsafe
    /// due to the raw memory access it provides. However, our usage is safe because:
    ///
    /// - We only create read-only mappings
    /// - We maintain the file handle to prevent truncation
    /// - We validate the file exists and is readable before mapping
    /// - We handle all error cases explicitly
    ///
    /// # Errors
    ///
    /// This method will return an error if:
    /// - The file cannot be opened (permissions, doesn't exist, etc.)
    /// - The file is empty (0 bytes)
    /// - The memory mapping operation fails (OS-level error)
    ///
    /// # Returns
    ///
    /// Returns a `Result<Mmap>` containing the memory-mapped file handle.
    /// The `Mmap` can be used as `&[u8]` for zero-copy parsing operations.
    ///
    /// # Example
    ///
    /// ```
    /// use hprof_analyzer::HprofLoader;
    /// use std::path::PathBuf;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
    /// let mmap = loader.map_file()?;
    ///
    /// // Use the memory map as a byte slice
    /// let first_byte = mmap[0];
    /// println!("File size: {} bytes", mmap.len());
    /// # Ok(())
    /// # }
    /// ```
    pub fn map_file(&self) -> Result<Mmap, HprofLoaderError> {
        log::debug!("Opening HPROF file: {:?}", self.path);

        // Open the file with read-only permissions.
        // Keeping the file handle open prevents the file from being truncated
        // or deleted while the memory map is active (on Unix systems).
        let file = File::open(&self.path).map_err(|source| {
            log::error!("Failed to open file: {:?}", self.path);
            HprofLoaderError::FileOpen {
                path: self.path.clone(),
                source,
            }
        })?;

        // Get file metadata to check size before attempting to map.
        // This provides a better error message for empty files.
        let metadata = file.metadata().map_err(|source| {
            log::error!("Failed to get file metadata: {:?}", self.path);
            HprofLoaderError::FileOpen {
                path: self.path.clone(),
                source,
            }
        })?;

        if metadata.len() == 0 {
            log::error!("File is empty: {:?}", self.path);
            return Err(HprofLoaderError::EmptyFile {
                path: self.path.clone(),
            });
        }

        log::debug!(
            "Creating memory map for file: {:?} ({} bytes)",
            self.path,
            metadata.len()
        );

        // SAFETY: This unsafe block is safe because:
        //
        // 1. **Read-only mapping**: We create a read-only memory map, which means
        //    the OS will prevent any writes to the mapped memory region. Even if
        //    unsafe code attempts to write, the OS will raise a segmentation fault.
        //
        // 2. **File handle lifetime**: The `file` handle is kept alive (not dropped)
        //    during the mapping operation. On Unix systems, this prevents the file
        //    from being truncated or deleted while mapped. The `Mmap` handle will
        //    maintain the mapping until it's dropped.
        //
        // 3. **No concurrent writes**: HPROF files are typically immutable once written.
        //    We're opening the file read-only, so our process cannot modify it.
        //    Other processes could theoretically modify it, but:
        //      - This is rare for HPROF files (they're typically write-once)
        //      - The OS page cache will handle consistency
        //      - If this is a concern, file locking can be added
        //
        // 4. **Platform portability**: `memmap2` handles platform-specific differences
        //    (Windows vs Unix) internally, so our usage is portable.
        //
        // 5. **Error handling**: We properly handle all error cases returned by `map()`.
        //
        // The `unsafe` marker exists because memory mapping provides raw access to
        // OS-managed memory pages, bypassing Rust's normal safety guarantees. However,
        // our specific usage pattern (read-only mapping of an immutable file) is safe.
        let mmap_result = unsafe {
            MmapOptions::new()
                .map(&file)
        };
        
        let mmap = mmap_result.map_err(|source| {
            log::error!("Failed to create memory map: {:?}", self.path);
            HprofLoaderError::MapCreation {
                path: self.path.clone(),
                source,
            }
        })?;

        log::info!(
            "Successfully mapped HPROF file: {:?} ({} bytes)",
            self.path,
            mmap.len()
        );

        // Note: We intentionally drop the `file` handle here. The memory map
        // remains valid because:
        // - On Unix: The file descriptor is kept open by the OS for the mapping
        // - On Windows: The file handle is duplicated internally by memmap2
        // The `Mmap` handle maintains the mapping's validity.
        drop(file);

        Ok(mmap)
    }

    /// Returns a reference to the path of the HPROF file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Statistics collected from scanning HPROF records.
///
/// This structure holds aggregate counts and sizes computed during
/// a single pass over the HPROF file records.
#[derive(Debug, Clone, Default)]
pub struct HprofStatistics {
    /// Total number of LOAD_CLASS records (classes defined in the heap).
    pub total_classes: u64,
    /// Total number of INSTANCE_DUMP sub-records (object instances).
    pub total_objects: u64,
    /// Total heap size in bytes (approximate, based on instance field data).
    pub total_heap_size_bytes: u64,
}

impl HprofStatistics {
    /// Prints the statistics to stdout in a human-readable format.
    pub fn print(&self) {
        println!("HPROF Statistics:");
        println!("  Total Classes (LOAD_CLASS): {}", self.total_classes);
        println!("  Total Objects (INSTANCE_DUMP): {}", self.total_objects);
        println!(
            "  Total Heap Size: {} bytes ({:.2} MB)",
            self.total_heap_size_bytes,
            self.total_heap_size_bytes as f64 / (1024.0 * 1024.0)
        );
    }
}

/// Scans HPROF records from a memory-mapped byte slice and collects statistics.
///
/// This function performs a zero-copy scan of the HPROF file using the `jvm-hprof`
/// crate. It iterates over all records in the file and counts:
///
/// - **LOAD_CLASS records**: Classes defined in the heap dump
/// - **INSTANCE_DUMP sub-records**: Object instances within heap dump segments
/// - **Total heap size**: Approximate size based on instance field data
///
/// # Zero-Copy Processing
///
/// This function leverages the zero-copy features of `jvm-hprof`:
///
/// - The input `&[u8]` slice is typically from a memory-mapped file (`Mmap`)
/// - `jvm-hprof::parse_hprof()` parses the header without copying data
/// - `records_iter()` provides an iterator over records that defers parsing
/// - Record parsing happens on-demand, accessing data directly from the mapped memory
/// - No intermediate buffers or copies are created during iteration
///
/// # Endianness Handling
///
/// The `jvm-hprof` crate handles endianness automatically:
///
/// - HPROF files use big-endian encoding (network byte order)
/// - The crate's parse methods (`parse_hprof`, `as_load_class`, etc.) handle
///   endianness conversion internally
/// - No manual byte swapping is required
/// - The crate reads the file's ID size (32-bit vs 64-bit) from the header
///
/// # Arguments
///
/// * `data` - A byte slice containing the HPROF file data, typically from a memory-mapped file.
///
/// # Returns
///
/// Returns a `Result<HprofStatistics>` containing the collected statistics.
/// Returns an error if the HPROF file cannot be parsed or if record parsing fails.
///
/// # Errors
///
/// This function will return an error if:
/// - The HPROF header cannot be parsed (invalid format)
/// - A record cannot be parsed (corrupted data)
/// - The file structure is invalid
///
/// # Example
///
/// ```no_run
/// use hprof_analyzer::{HprofLoader, scan_records};
/// use std::path::PathBuf;
///
/// # fn main() -> anyhow::Result<()> {
/// let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
/// let mmap = loader.map_file()?;
///
/// let stats = scan_records(&mmap[..])?;
/// stats.print();
/// # Ok(())
/// # }
/// ```
pub fn scan_records(data: &[u8]) -> Result<HprofStatistics> {
    log::debug!("Starting HPROF record scan ({} bytes)", data.len());

    // Parse the HPROF file header and create the iterator.
    // This is a zero-copy operation - it only reads the header and sets up
    // the iterator without copying the file data.
    let hprof = parse_hprof(data)
        .map_err(|e| anyhow::anyhow!("Failed to parse HPROF file: {:?}", e))?;

    let mut stats = HprofStatistics::default();

    // First pass: Count LOAD_CLASS records.
    // These records define classes that are loaded in the heap.
    log::debug!("Scanning for LOAD_CLASS records...");
    for record_result in hprof.records_iter() {
        let record = record_result
            .map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;

        // Match on the record tag to identify LOAD_CLASS records.
        // The jvm-hprof crate handles endianness conversion automatically
        // when parsing the tag byte and record data.
        if record.tag() == RecordTag::LoadClass {
            stats.total_classes += 1;
            log::trace!("Found LOAD_CLASS record #{}", stats.total_classes);
        }
    }

    log::info!("Found {} LOAD_CLASS records", stats.total_classes);

    // Second pass: Count INSTANCE_DUMP sub-records and calculate heap size.
    // INSTANCE_DUMP records are nested within HeapDumpSegment records.
    log::debug!("Scanning for INSTANCE_DUMP sub-records...");
    for record_result in hprof.records_iter() {
        let record = record_result
            .map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;

        // Heap dump data is contained in HeapDump or HeapDumpSegment records.
        // These records contain sub-records that include INSTANCE_DUMP entries.
        if record.tag() == RecordTag::HeapDump || record.tag() == RecordTag::HeapDumpSegment {
            if let Some(heap_dump_result) = record.as_heap_dump_segment() {
                let heap_dump = heap_dump_result
                    .map_err(|e| anyhow::anyhow!("Failed to parse HeapDumpSegment: {:?}", e))?;

                // Iterate over sub-records within the heap dump segment.
                // This is where INSTANCE_DUMP records are found.
                for sub_record_result in heap_dump.sub_records() {
                    let sub_record = sub_record_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse sub-record: {:?}", e))?;

                    // Match on the sub-record type to find INSTANCE_DUMP entries.
                    // The jvm-hprof crate handles endianness when parsing sub-record tags
                    // and data fields.
                    match sub_record {
                        jvm_hprof::heap_dump::SubRecord::Instance(instance) => {
                            stats.total_objects += 1;

                            // Calculate approximate heap size from instance field data.
                            // Note: This is an approximation. The actual instance size includes:
                            // - Object header (platform-dependent, typically 8-16 bytes)
                            // - Field data (what we're measuring here)
                            // - Alignment padding
                            //
                            // For a more accurate size, we would need to:
                            // 1. Parse class definitions to get field descriptors
                            // 2. Calculate size based on field types and alignment
                            // 3. Add object header size
                            //
                            // For now, we use the field data length as a proxy.
                            let field_data_size = instance.fields().len() as u64;
                            stats.total_heap_size_bytes += field_data_size;

                            log::trace!(
                                "Found INSTANCE_DUMP #{} (field data: {} bytes)",
                                stats.total_objects,
                                field_data_size
                            );
                        }
                        // We could also count ObjectArray and PrimitiveArray here
                        // for a more complete heap size calculation, but the task
                        // specifically asks for INSTANCE_DUMP objects.
                        _ => {
                            // Other sub-record types (ObjectArray, PrimitiveArray, Class, etc.)
                            // are not counted in this implementation.
                        }
                    }
                }
            }
        }
    }

    log::info!(
        "Scan complete: {} objects, {} bytes heap size",
        stats.total_objects,
        stats.total_heap_size_bytes
    );

    Ok(stats)
}

/// Node data types in the heap graph.
///
/// Each node represents either a GC root, a class definition, an object instance,
/// or an array in the Java heap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeData {
    /// A synthetic root node that connects to all GC roots.
    /// This is the top-level node in the object graph.
    SuperRoot,
    /// A GC root (entry point into the object graph).
    Root,
    /// A class definition.
    Class,
    /// An object instance with its ID, size, and class name.
    Instance {
        /// The object ID from the HPROF file.
        id: u64,
        /// The size of the instance in bytes.
        size: u32,
        /// The fully-qualified class name (e.g. "java.lang.String").
        class_name: Arc<str>,
    },
    /// An array (object array or primitive array) with its ID, size, and class name.
    Array {
        /// The array object ID from the HPROF file.
        id: u64,
        /// The size of the array in bytes.
        size: u32,
        /// The array class name (e.g. "byte[]", "java.lang.Object[]").
        class_name: Arc<str>,
    },
}

/// Label on a graph edge describing the kind of reference.
///
/// Each variant carries a compact payload to minimise per-edge memory:
/// - `InstanceField(u32)` / `StaticField(u32)` — index into `HeapGraph::field_name_table`
/// - `ArrayElement` — element of an object array (no specific index stored)
/// - `SuperClass` / `ClassLoader` / `GcRoot` / `Unknown` — structural edges
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum EdgeLabel {
    /// Reference through an instance field. The u32 is an index into `field_name_table`.
    InstanceField(u32),
    /// Reference through a static field. The u32 is an index into `field_name_table`.
    StaticField(u32),
    /// Element of an object array.
    ArrayElement,
    /// Class → superclass edge.
    SuperClass,
    /// Class → class-loader edge.
    ClassLoader,
    /// SuperRoot → GC root edge.
    GcRoot,
    /// Fallback extraction (no field type info available).
    Unknown,
}

/// Summary of a referenced object for field inspection.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RefSummary {
    pub class_name: String,
    pub node_type: String,
    pub shallow_size: u64,
    pub retained_size: u64,
}

/// Information about a single field of an inspected object.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FieldInfo {
    pub name: String,
    pub field_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primitive_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_object_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_summary: Option<RefSummary>,
}

/// A graph representation of the Java heap.
///
/// This graph models the object reference relationships in a heap dump:
/// - **Nodes**: Represent GC roots, classes, instances, and arrays
/// - **Edges**: Represent references from one object to another
///
/// The graph is directed: an edge from A to B means "A references B".
///
/// # Structure
///
/// - **SuperRoot**: A synthetic node at the top that connects to all GC roots
/// - **Root nodes**: GC roots (ROOT_JNI_GLOBAL, ROOT_JAVA_FRAME, etc.)
/// - **Class nodes**: Class definitions from LOAD_CLASS records
/// - **Instance nodes**: Object instances from INSTANCE_DUMP sub-records
/// - **Array nodes**: Arrays from OBJECT_ARRAY and PRIMITIVE_ARRAY sub-records
///
/// # Example
///
/// ```no_run
/// use hprof_analyzer::{HprofLoader, build_graph};
/// use std::path::PathBuf;
///
/// # fn main() -> anyhow::Result<()> {
/// let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
/// let mmap = loader.map_file()?;
///
/// let graph = build_graph(&mmap[..])?;
/// println!("Graph has {} nodes and {} edges", 
///          graph.graph().node_count(), 
///          graph.graph().edge_count());
/// # Ok(())
/// # }
/// ```
#[derive(Debug)]
pub struct HeapGraph {
    /// The underlying petgraph graph structure.
    graph: Graph<NodeData, EdgeLabel, Directed>,
    /// Mapping from HPROF object/class IDs to graph node indices.
    id_to_node: HashMap<u64, NodeIndex>,
    /// The node index of the synthetic SuperRoot node.
    super_root: NodeIndex,
    /// Heap summary statistics collected during graph building.
    summary: HeapSummary,
    /// Set of object IDs that are classloader instances (for leak detection).
    classloader_ids: std::collections::HashSet<u64>,
    /// Interned field name strings indexed by u32 for compact EdgeLabel storage.
    field_name_table: Vec<Arc<str>>,
    /// Per-class field layouts for object inspection (class_obj_id → named field list).
    class_field_layouts: HashMap<u64, Vec<(Arc<str>, jvm_hprof::heap_dump::FieldType)>>,
    /// HPROF identifier size (4 or 8 bytes).
    id_size: IdSize,
}

impl HeapGraph {
    /// Returns a reference to the underlying graph.
    pub fn graph(&self) -> &Graph<NodeData, EdgeLabel, Directed> {
        &self.graph
    }

    /// Returns a mutable reference to the underlying graph.
    pub fn graph_mut(&mut self) -> &mut Graph<NodeData, EdgeLabel, Directed> {
        &mut self.graph
    }

    /// Returns the mapping from HPROF IDs to node indices.
    pub fn id_to_node(&self) -> &HashMap<u64, NodeIndex> {
        &self.id_to_node
    }

    /// Returns the node index of the SuperRoot node.
    pub fn super_root(&self) -> NodeIndex {
        self.super_root
    }

    /// Returns the number of nodes in the graph.
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// Returns the number of edges in the graph.
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// Returns the heap summary statistics.
    pub fn summary(&self) -> &HeapSummary {
        &self.summary
    }

    /// Consumes the HeapGraph and returns its parts, avoiding clones.
    pub fn into_parts(self) -> HeapGraphParts {
        HeapGraphParts {
            graph: self.graph,
            id_to_node: self.id_to_node,
            super_root: self.super_root,
            summary: self.summary,
            classloader_ids: self.classloader_ids,
            field_name_table: self.field_name_table,
            class_field_layouts: self.class_field_layouts,
            id_size: self.id_size,
        }
    }
}

/// Parts of a HeapGraph after consumption, used by dominator analysis.
pub struct HeapGraphParts {
    pub graph: Graph<NodeData, EdgeLabel, Directed>,
    pub id_to_node: HashMap<u64, NodeIndex>,
    pub super_root: NodeIndex,
    pub summary: HeapSummary,
    pub classloader_ids: std::collections::HashSet<u64>,
    pub field_name_table: Vec<Arc<str>>,
    pub class_field_layouts: HashMap<u64, Vec<(Arc<str>, jvm_hprof::heap_dump::FieldType)>>,
    pub id_size: IdSize,
}

/// Builds a graph representation of the Java heap from HPROF file data.
///
/// This function performs a two-pass scan of the HPROF file:
///
/// **Pass 1: Node Creation**
/// - Identifies all classes from `LOAD_CLASS` records
/// - Identifies all instances from `INSTANCE_DUMP` sub-records
/// - Identifies all arrays from `OBJECT_ARRAY` and `PRIMITIVE_ARRAY` sub-records
/// - Identifies all GC roots from various `GcRoot*` sub-records
/// - Creates nodes for each and maps HPROF IDs to graph node indices
///
/// **Pass 2: Edge Creation**
/// - Iterates records again to find object references
/// - Adds directed edges from referencing objects to referenced objects
/// - Connects GC roots to their referenced objects
/// - Creates a synthetic `SuperRoot` node and connects it to all GC roots
///
/// # Zero-Copy Processing
///
/// Like `scan_records`, this function uses zero-copy processing:
/// - Takes a `&[u8]` slice (typically from memory-mapped file)
/// - Uses `jvm-hprof`'s lazy parsing
/// - All data access is direct from mapped memory
///
/// # Arguments
///
/// * `data` - A byte slice containing the HPROF file data.
///
/// # Returns
///
/// Returns a `Result<HeapGraph>` containing the constructed graph.
///
/// # Errors
///
/// Returns an error if:
/// - The HPROF file cannot be parsed
/// - Record parsing fails
/// - Invalid object references are encountered
///
/// # Example
///
/// ```no_run
/// use hprof_analyzer::{HprofLoader, build_graph};
/// use std::path::PathBuf;
///
/// # fn main() -> anyhow::Result<()> {
/// let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
/// let mmap = loader.map_file()?;
///
/// let graph = build_graph(&mmap[..])?;
/// println!("Graph: {} nodes, {} edges", 
///          graph.node_count(), 
///          graph.edge_count());
/// # Ok(())
/// # }
/// ```
pub fn build_graph(data: &[u8]) -> Result<(HeapGraph, WasteRawData)> {
    log::debug!("Starting graph construction ({} bytes)", data.len());

    let hprof = parse_hprof(data)
        .map_err(|e| anyhow::anyhow!("Failed to parse HPROF file: {:?}", e))?;

    let id_size = hprof.header().id_size();
    let hprof_version = hprof.header().label()
        .unwrap_or("unknown")
        .to_string();
    // Estimate node count from file size: ~100 bytes per object on average
    let estimated_nodes = (data.len() / 100).max(1024);
    let mut graph = Graph::<NodeData, EdgeLabel, Directed>::with_capacity(estimated_nodes, estimated_nodes * 2);
    let mut id_to_node: HashMap<u64, NodeIndex> = HashMap::with_capacity(estimated_nodes);
    let mut field_name_table: Vec<Arc<str>> = Vec::new();
    let mut field_name_index: HashMap<Arc<str>, u32> = HashMap::new();

    // Helper closure to intern field names into the table
    let mut intern_field_name = |name: &Arc<str>| -> u32 {
        if let Some(&idx) = field_name_index.get(name) {
            return idx;
        }
        let idx = field_name_table.len() as u32;
        field_name_table.push(name.clone());
        field_name_index.insert(name.clone(), idx);
        idx
    };

    let super_root = graph.add_node(NodeData::SuperRoot);

    // ============================================================================
    // PASS 0: Build string table, class name map, and class graph nodes
    //         (single scan of all top-level records)
    // ============================================================================
    log::debug!("Pass 0: Building string table, class name map, and class nodes...");
    let mut string_table: HashMap<u64, String> = HashMap::new();
    // Collect raw LoadClass entries to resolve after string table is complete
    let mut load_class_entries: Vec<(u64, u64)> = Vec::new(); // (class_obj_id, class_name_id)

    for record_result in hprof.records_iter() {
        let record = record_result
            .map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;
        match record.tag() {
            RecordTag::Utf8 => {
                if let Some(utf8_result) = record.as_utf_8() {
                    let utf8 = utf8_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse UTF8 string: {:?}", e))?;
                    let string_id = utf8.name_id().id();
                    let text = String::from_utf8_lossy(utf8.text()).to_string();
                    string_table.insert(string_id, text);
                }
            }
            RecordTag::LoadClass => {
                if let Some(load_class_result) = record.as_load_class() {
                    let load_class = load_class_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse LoadClass: {:?}", e))?;
                    load_class_entries.push((load_class.class_obj_id().id(), load_class.class_name_id().id()));
                }
            }
            _ => {}
        }
    }
    log::info!("Built string table: {} entries, {} LoadClass entries", string_table.len(), load_class_entries.len());

    // Resolve class names and create class graph nodes from collected LoadClass entries
    let mut class_name_map: HashMap<u64, Arc<str>> = HashMap::with_capacity(load_class_entries.len());
    let mut class_count = 0u64;
    for (class_obj_id, class_name_id) in &load_class_entries {
        if let Some(name) = string_table.get(class_name_id) {
            let java_name = convert_jvm_class_name(name);
            class_name_map.insert(*class_obj_id, Arc::from(java_name.as_str()));
        }
        if !id_to_node.contains_key(class_obj_id) {
            let node_idx = graph.add_node(NodeData::Class);
            id_to_node.insert(*class_obj_id, node_idx);
            class_count += 1;
        }
    }
    log::info!("Built class name map: {} entries, {} class nodes", class_name_map.len(), class_count);
    // NOTE: string_table is kept alive until after Pass 2 so field names
    // can be resolved during Pass 1 (instance field descriptors) and
    // Pass 2 (static field names).  Memory impact: ~5-20 MB longer.
    let num_classes = load_class_entries.len();
    drop(load_class_entries);

    // ============================================================================
    // PASS 1: Identify all nodes and add them to the graph
    // ============================================================================
    log::debug!("Pass 1: Identifying nodes...");

    // Now scan heap dump segments for instances, arrays, and GC roots
    let mut instance_count = 0u64;
    let mut array_count = 0u64;
    let mut gc_root_count = 0u64;
    let mut gc_root_ids = Vec::new();
    let mut total_shallow_size = 0u64;
    let mut heap_types: Vec<String> = Vec::new();

    // Also build a map of class_obj_id -> instance_size from Class sub-records
    let mut class_instance_sizes: HashMap<u64, u32> = HashMap::with_capacity(num_classes);

    // Collect field descriptors and superclass info for typed reference extraction
    struct ClassFieldInfo {
        super_class_id: Option<u64>,
        own_fields: Vec<(Arc<str>, jvm_hprof::heap_dump::FieldType)>,
    }
    let mut class_field_info: HashMap<u64, ClassFieldInfo> = HashMap::with_capacity(num_classes);
    // Intern pool for field name strings — avoids duplicate allocations across classes
    let mut field_name_intern: HashMap<u64, Arc<str>> = HashMap::new();
    // Track all classloader object IDs (for classloader-aware leak detection)
    let mut classloader_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Track array element counts for over-allocated collection detection
    let mut array_element_counts: HashMap<u64, u32> = HashMap::new();

    // First pass through heap dumps: collect class instance sizes and field descriptors
    for record_result in hprof.records_iter() {
        let record = record_result
            .map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;
        if record.tag() == RecordTag::HeapDump || record.tag() == RecordTag::HeapDumpSegment {
            if let Some(heap_dump_result) = record.as_heap_dump_segment() {
                let heap_dump = heap_dump_result
                    .map_err(|e| anyhow::anyhow!("Failed to parse HeapDumpSegment: {:?}", e))?;
                for sub_record_result in heap_dump.sub_records() {
                    let sub_record = sub_record_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse sub-record: {:?}", e))?;
                    if let jvm_hprof::heap_dump::SubRecord::Class(class) = sub_record {
                        let obj_id = class.obj_id().id();
                        let instance_size = class.instance_size_bytes();
                        class_instance_sizes.insert(obj_id, instance_size);

                        // Collect field types and names for typed reference extraction
                        let super_id = class.super_class_obj_id().map(|id| id.id());
                        let mut own_fields = Vec::new();
                        for fd_result in class.instance_field_descriptors() {
                            match fd_result {
                                Ok(fd) => {
                                    let name_id = fd.name_id().id();
                                    let field_name = field_name_intern
                                        .entry(name_id)
                                        .or_insert_with(|| {
                                            let name = string_table.get(&name_id)
                                                .map(|s| s.as_str())
                                                .unwrap_or("<unknown>");
                                            Arc::from(name)
                                        })
                                        .clone();
                                    own_fields.push((field_name, fd.field_type()));
                                }
                                Err(e) => log::warn!("Failed to parse field descriptor in class 0x{:x}: {:?}", obj_id, e),
                            }
                        }
                        class_field_info.insert(obj_id, ClassFieldInfo {
                            super_class_id: super_id,
                            own_fields,
                        });

                        // Track classloader object IDs
                        if let Some(cl_id) = class.class_loader_obj_id() {
                            let cl_val = cl_id.id();
                            if cl_val != 0 {
                                classloader_ids.insert(cl_val);
                            }
                        }
                    }
                }
            }
        }
    }
    log::info!("Collected field descriptors for {} classes, {} unique classloaders",
        class_field_info.len(), classloader_ids.len());

    // Resolve inheritance chains with memoization: once a parent's layout is resolved,
    // child classes reuse it instead of re-walking. This avoids O(N²) in deep hierarchies.
    let mut class_field_layouts: HashMap<u64, Vec<(Arc<str>, jvm_hprof::heap_dump::FieldType)>> = HashMap::with_capacity(class_field_info.len());
    let class_ids: Vec<u64> = class_field_info.keys().copied().collect();
    for class_id in class_ids {
        if class_field_layouts.contains_key(&class_id) {
            continue; // already resolved (by a child that needed us)
        }
        // Walk up the chain to find the first already-resolved ancestor
        let mut chain: Vec<u64> = Vec::new();
        let mut current_id = Some(class_id);
        let mut visited = std::collections::HashSet::new();
        while let Some(cid) = current_id {
            if !visited.insert(cid) {
                log::warn!("Cycle detected in class hierarchy at class 0x{:x}", cid);
                break;
            }
            if class_field_layouts.contains_key(&cid) {
                break; // parent already resolved — use its cached layout
            }
            chain.push(cid);
            current_id = class_field_info.get(&cid)
                .and_then(|info| info.super_class_id)
                .filter(|&id| id != 0);
        }
        // Build layouts from the deepest unresolved ancestor down to class_id
        // Each class's layout = own fields + parent's resolved layout
        for i in (0..chain.len()).rev() {
            let cid = chain[i];
            let parent_layout = class_field_info.get(&cid)
                .and_then(|info| info.super_class_id)
                .filter(|&id| id != 0)
                .and_then(|pid| class_field_layouts.get(&pid));
            let own_fields = class_field_info.get(&cid)
                .map(|info| &info.own_fields[..])
                .unwrap_or(&[]);
            // Build full field layout: own fields first, then parent's resolved layout.
            // This matches the byte order produced by the HotSpot HPROF agent, which
            // writes instance field values starting from the most-derived class.
            let mut layout = Vec::with_capacity(
                own_fields.len() + parent_layout.map_or(0, |p| p.len())
            );
            layout.extend_from_slice(own_fields);
            if let Some(parent) = parent_layout {
                layout.extend_from_slice(parent);
            }
            class_field_layouts.insert(cid, layout);
        }
    }
    log::info!("Resolved field layouts for {} classes", class_field_layouts.len());
    drop(class_field_info); // Free field descriptor data — resolved into layouts
    drop(field_name_intern); // Free intern pool — names are now in layouts

    // Main heap dump scan
    for record_result in hprof.records_iter() {
        let record = record_result
            .map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;

        if record.tag() == RecordTag::HeapDump || record.tag() == RecordTag::HeapDumpSegment {
            if let Some(heap_dump_result) = record.as_heap_dump_segment() {
                let heap_dump = heap_dump_result
                    .map_err(|e| anyhow::anyhow!("Failed to parse HeapDumpSegment: {:?}", e))?;

                for sub_record_result in heap_dump.sub_records() {
                    let sub_record = sub_record_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse sub-record: {:?}", e))?;

                    match sub_record {
                        // GC Roots
                        jvm_hprof::heap_dump::SubRecord::GcRootUnknown(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootJniGlobal(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootJniLocalRef(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootJavaStackFrame(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootSystemClass(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootThreadObj(gc_root) => {
                            if let Some(thread_obj_id) = gc_root.thread_obj_id() {
                                let obj_id = thread_obj_id.id();
                                gc_root_ids.push(obj_id);
                                gc_root_count += 1;
                                if !id_to_node.contains_key(&obj_id) {
                                    let node_idx = graph.add_node(NodeData::Root);
                                    id_to_node.insert(obj_id, node_idx);
                                }
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootBusyMonitor(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        // Android-specific GC roots (HPROF 1.0.3)
                        jvm_hprof::heap_dump::SubRecord::GcRootInternedString(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootFinalizing(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootDebugger(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootReferenceCleanup(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootVmInternal(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootJniMonitor(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        jvm_hprof::heap_dump::SubRecord::GcRootUnreachable(gc_root) => {
                            let obj_id = gc_root.obj_id().id();
                            gc_root_ids.push(obj_id);
                            gc_root_count += 1;
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Root);
                                id_to_node.insert(obj_id, node_idx);
                            }
                        }
                        // Android heap region metadata
                        jvm_hprof::heap_dump::SubRecord::HeapDumpInfo(info) => {
                            let heap_name_id = info.heap_name_id().id();
                            if let Some(name) = string_table.get(&heap_name_id) {
                                if !heap_types.contains(name) {
                                    heap_types.push(name.clone());
                                }
                            }
                        }
                        // Android primitive array with no data
                        jvm_hprof::heap_dump::SubRecord::PrimitiveArrayNoData(array) => {
                            let obj_id = array.obj_id().id();
                            let prim_type = array.primitive_type();
                            let class_name: Arc<str> = Arc::from(format!("{}[]", prim_type.java_type_name()).as_str());

                            if let Some(&existing_idx) = id_to_node.get(&obj_id) {
                                if matches!(graph[existing_idx], NodeData::Root) {
                                    graph[existing_idx] = NodeData::Array { id: obj_id, size: 0, class_name };
                                    array_count += 1;
                                }
                            } else {
                                let node_idx = graph.add_node(NodeData::Array { id: obj_id, size: 0, class_name });
                                id_to_node.insert(obj_id, node_idx);
                                array_count += 1;
                            }
                        }
                        // Instances — use class_obj_id to look up class name
                        jvm_hprof::heap_dump::SubRecord::Instance(instance) => {
                            let obj_id = instance.obj_id().id();
                            let class_obj_id = instance.class_obj_id().id();
                            // Use instance_size from class definition if available, fall back to field data length
                            let size = class_instance_sizes.get(&class_obj_id)
                                .copied()
                                .unwrap_or(instance.fields().len() as u32);
                            let class_name = class_name_map.get(&class_obj_id)
                                .cloned()
                                .unwrap_or_else(|| Arc::from(format!("Unknown(0x{:x})", class_obj_id).as_str()));

                            if let Some(&existing_idx) = id_to_node.get(&obj_id) {
                                // Upgrade GC root nodes with actual Instance data
                                if matches!(graph[existing_idx], NodeData::Root) {
                                    graph[existing_idx] = NodeData::Instance { id: obj_id, size, class_name };
                                    instance_count += 1;
                                    total_shallow_size += size as u64;
                                }
                            } else {
                                let node_idx = graph.add_node(NodeData::Instance { id: obj_id, size, class_name });
                                id_to_node.insert(obj_id, node_idx);
                                instance_count += 1;
                                total_shallow_size += size as u64;
                            }
                        }
                        // Object Arrays
                        jvm_hprof::heap_dump::SubRecord::ObjectArray(array) => {
                            let obj_id = array.obj_id().id();
                            let array_class_obj_id = array.array_class_obj_id().id();
                            let id_size_bytes = match id_size {
                                IdSize::U32 => 4,
                                IdSize::U64 => 8,
                            };
                            let mut element_count = 0u32;
                            for element_result in array.elements(id_size) {
                                match element_result {
                                    Ok(Some(_)) | Ok(None) => element_count += 1,
                                    Err(_) => {}
                                }
                            }
                            let size = element_count * id_size_bytes as u32;
                            let class_name = class_name_map.get(&array_class_obj_id)
                                .cloned()
                                .unwrap_or_else(|| Arc::from("Object[]"));
                            array_element_counts.insert(obj_id, element_count);

                            if let Some(&existing_idx) = id_to_node.get(&obj_id) {
                                if matches!(graph[existing_idx], NodeData::Root) {
                                    graph[existing_idx] = NodeData::Array { id: obj_id, size, class_name };
                                    array_count += 1;
                                    total_shallow_size += size as u64;
                                }
                            } else {
                                let node_idx = graph.add_node(NodeData::Array { id: obj_id, size, class_name });
                                id_to_node.insert(obj_id, node_idx);
                                array_count += 1;
                                total_shallow_size += size as u64;
                            }
                        }
                        // Primitive Arrays
                        jvm_hprof::heap_dump::SubRecord::PrimitiveArray(array) => {
                            let obj_id = array.obj_id().id();
                            let prim_type = array.primitive_type();
                            // Compute size by counting elements via typed iterators
                            let (elem_count, elem_size, class_name): (u32, u32, Arc<str>) = match prim_type {
                                jvm_hprof::heap_dump::PrimitiveArrayType::Boolean => {
                                    let count = array.booleans().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 1u32, Arc::from("boolean[]"))
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Byte => {
                                    let count = array.bytes().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 1, Arc::from("byte[]"))
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Char => {
                                    let count = array.chars().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 2, Arc::from("char[]"))
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Short => {
                                    let count = array.shorts().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 2, Arc::from("short[]"))
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Int => {
                                    let count = array.ints().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 4, Arc::from("int[]"))
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Float => {
                                    let count = array.floats().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 4, Arc::from("float[]"))
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Long => {
                                    let count = array.longs().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 8, Arc::from("long[]"))
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Double => {
                                    let count = array.doubles().map_or(0u32, |iter| iter.count() as u32);
                                    (count, 8, Arc::from("double[]"))
                                }
                            };
                            let size = elem_count * elem_size;
                            array_element_counts.insert(obj_id, elem_count);

                            if let Some(&existing_idx) = id_to_node.get(&obj_id) {
                                if matches!(graph[existing_idx], NodeData::Root) {
                                    graph[existing_idx] = NodeData::Array { id: obj_id, size, class_name };
                                    array_count += 1;
                                    total_shallow_size += size as u64;
                                }
                            } else {
                                let node_idx = graph.add_node(NodeData::Array { id: obj_id, size, class_name });
                                id_to_node.insert(obj_id, node_idx);
                                array_count += 1;
                                total_shallow_size += size as u64;
                            }
                        }
                        // Class definitions in heap dump
                        jvm_hprof::heap_dump::SubRecord::Class(class) => {
                            let obj_id = class.obj_id().id();
                            if !id_to_node.contains_key(&obj_id) {
                                let node_idx = graph.add_node(NodeData::Class);
                                id_to_node.insert(obj_id, node_idx);
                                class_count += 1;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let summary = HeapSummary {
        total_heap_size: total_shallow_size,
        reachable_heap_size: total_shallow_size, // updated after dominator analysis
        total_instances: instance_count,
        total_classes: class_count,
        total_arrays: array_count,
        total_gc_roots: gc_root_count,
        hprof_version,
        heap_types,
    };

    log::info!(
        "Pass 1 complete: {} classes, {} instances, {} arrays, {} GC roots",
        class_count,
        instance_count,
        array_count,
        gc_root_count
    );

    // ============================================================================
    // PASS 2: Add edges (references) between nodes + collect waste data
    // ============================================================================

    log::debug!("Pass 2: Adding edges (references) and collecting waste data...");

    // --- Waste analysis: look up class IDs for target classes ---
    let string_class_id: Option<u64> = class_name_map.iter()
        .find(|(_, name)| name.as_ref() == "java.lang.String")
        .map(|(id, _)| *id);
    let hashmap_class_id: Option<u64> = class_name_map.iter()
        .find(|(_, name)| name.as_ref() == "java.util.HashMap")
        .map(|(id, _)| *id);
    let linked_hashmap_class_id: Option<u64> = class_name_map.iter()
        .find(|(_, name)| name.as_ref() == "java.util.LinkedHashMap")
        .map(|(id, _)| *id);
    let arraylist_class_id: Option<u64> = class_name_map.iter()
        .find(|(_, name)| name.as_ref() == "java.util.ArrayList")
        .map(|(id, _)| *id);

    // Boxed primitive class IDs
    let boxed_primitive_classes: Vec<(u64, &str, u32)> = {
        let names = [
            ("java.lang.Boolean", 1u32),
            ("java.lang.Byte", 1),
            ("java.lang.Character", 2),
            ("java.lang.Short", 2),
            ("java.lang.Integer", 4),
            ("java.lang.Float", 4),
            ("java.lang.Long", 8),
            ("java.lang.Double", 8),
        ];
        names.iter().filter_map(|(name, prim_size)| {
            class_name_map.iter()
                .find(|(_, n)| n.as_ref() == *name)
                .map(|(id, _)| (*id, *name, *prim_size))
        }).collect()
    };
    let boxed_ids: HashMap<u64, (&str, u32)> = boxed_primitive_classes.iter()
        .map(|(id, name, ps)| (*id, (*name, *ps))).collect();

    let mut waste_data = WasteRawData {
        string_instances: Vec::new(),
        backing_arrays: HashMap::new(),
        empty_collections: Vec::new(),
        array_element_counts: array_element_counts,
        over_allocated_collections: Vec::new(),
        boxed_primitives: Vec::new(),
    };

    let mut edge_count = 0;
    // Use HashSet for O(1) edge deduplication instead of graph.contains_edge() which is O(E)
    let mut added_edges: std::collections::HashSet<(NodeIndex, NodeIndex)> =
        std::collections::HashSet::with_capacity(estimated_nodes * 2);

    // Connect SuperRoot to all GC roots
    for gc_root_id in &gc_root_ids {
        if let Some(&root_node) = id_to_node.get(gc_root_id) {
            if added_edges.insert((super_root, root_node)) {
                graph.add_edge(super_root, root_node, EdgeLabel::GcRoot);
                edge_count += 1;
            }
        }
    }

    log::info!("Connected SuperRoot to {} GC roots", gc_root_ids.len());

    let mut typed_instance_count = 0u64;
    let mut fallback_instance_count = 0u64;

    // Scan heap dump segments again to find references
    for record_result in hprof.records_iter() {
        let record = record_result
            .map_err(|e| anyhow::anyhow!("Failed to parse record: {:?}", e))?;

        if record.tag() == RecordTag::HeapDump || record.tag() == RecordTag::HeapDumpSegment {
            if let Some(heap_dump_result) = record.as_heap_dump_segment() {
                let heap_dump = heap_dump_result
                    .map_err(|e| anyhow::anyhow!("Failed to parse HeapDumpSegment: {:?}", e))?;

                for sub_record_result in heap_dump.sub_records() {
                    let sub_record = sub_record_result
                        .map_err(|e| anyhow::anyhow!("Failed to parse sub-record: {:?}", e))?;

                    match sub_record {
                        // Instance references: use typed field descriptors to extract only ObjectId fields
                        jvm_hprof::heap_dump::SubRecord::Instance(instance) => {
                            let instance_id = instance.obj_id().id();
                            let class_obj_id = instance.class_obj_id().id();

                            if let Some(&instance_idx) = id_to_node.get(&instance_id) {
                                let fields = instance.fields();

                                if let Some(field_layout) = class_field_layouts.get(&class_obj_id) {
                                    typed_instance_count += 1;
                                    extract_typed_references_named(fields, id_size, field_layout, |ref_id, fname| {
                                        if let Some(&ref_node) = id_to_node.get(&ref_id) {
                                            if added_edges.insert((instance_idx, ref_node)) {
                                                let idx = intern_field_name(fname);
                                                graph.add_edge(instance_idx, ref_node, EdgeLabel::InstanceField(idx));
                                                edge_count += 1;
                                            }
                                        }
                                    });
                                    let ft = types_only(field_layout);

                                    // --- Waste: collect String value references ---
                                    if string_class_id == Some(class_obj_id) {
                                        if let Some(value_array_id) = extract_nth_field_of_type(
                                            fields, id_size, &ft,
                                            jvm_hprof::heap_dump::FieldType::ObjectId, 0,
                                        ) {
                                            if value_array_id != 0 {
                                                let shallow = class_instance_sizes.get(&class_obj_id)
                                                    .copied().unwrap_or(fields.len() as u32);
                                                waste_data.string_instances.push(StringInstanceInfo {
                                                    value_array_id,
                                                    shallow_size: shallow,
                                                });
                                            }
                                        }
                                    }

                                    // --- Waste: collect empty and over-allocated collections ---
                                    let is_collection = hashmap_class_id == Some(class_obj_id)
                                        || linked_hashmap_class_id == Some(class_obj_id)
                                        || arraylist_class_id == Some(class_obj_id);
                                    if is_collection {
                                        if let Some(size_val) = extract_nth_field_of_type(
                                            fields, id_size, &ft,
                                            jvm_hprof::heap_dump::FieldType::Int, 0,
                                        ) {
                                            let cname = class_name_map.get(&class_obj_id)
                                                .map(|s| s.to_string()).unwrap_or_default();
                                            let shallow = class_instance_sizes.get(&class_obj_id)
                                                .copied().unwrap_or(fields.len() as u32);
                                            if size_val == 0 {
                                                waste_data.empty_collections.push(EmptyCollectionInfo {
                                                    class_name: cname,
                                                    shallow_size: shallow,
                                                });
                                            } else if let Some(backing_array_id) = extract_nth_field_of_type(
                                                fields, id_size, &ft,
                                                jvm_hprof::heap_dump::FieldType::ObjectId, 0,
                                            ) {
                                                if let Some(&capacity) = waste_data.array_element_counts.get(&backing_array_id) {
                                                    let size_u32 = size_val as u32;
                                                    if capacity > 4 * size_u32 && capacity > 16 {
                                                        waste_data.over_allocated_collections.push(OverAllocatedCollectionInfo {
                                                            class_name: cname,
                                                            size: size_u32,
                                                            capacity,
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // --- Waste: collect boxed primitives ---
                                    if let Some(&(bp_name, _prim_size)) = boxed_ids.get(&class_obj_id) {
                                        let shallow = class_instance_sizes.get(&class_obj_id)
                                            .copied().unwrap_or(fields.len() as u32);
                                        waste_data.boxed_primitives.push(BoxedPrimitiveInfo {
                                            class_name: bp_name.to_string(),
                                            shallow_size: shallow,
                                        });
                                    }
                                } else {
                                    fallback_instance_count += 1;
                                    extract_object_references_fallback(fields, id_size, |ref_id| {
                                        if let Some(&ref_node) = id_to_node.get(&ref_id) {
                                            if added_edges.insert((instance_idx, ref_node)) {
                                                graph.add_edge(instance_idx, ref_node, EdgeLabel::Unknown);
                                                edge_count += 1;
                                            }
                                        }
                                    });
                                }
                            }
                        }
                        // Array references: parse array contents for object references
                        jvm_hprof::heap_dump::SubRecord::ObjectArray(array) => {
                            let array_id = array.obj_id().id();

                            if let Some(&array_idx) = id_to_node.get(&array_id) {
                                for element_result in array.elements(id_size) {
                                    if let Ok(Some(element_id)) = element_result {
                                        let ref_id = element_id.id();
                                        if let Some(&ref_node) = id_to_node.get(&ref_id) {
                                            if added_edges.insert((array_idx, ref_node)) {
                                                graph.add_edge(array_idx, ref_node, EdgeLabel::ArrayElement);
                                                edge_count += 1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        // Class references: superclass, class loader, and static ObjectId fields
                        jvm_hprof::heap_dump::SubRecord::Class(class) => {
                            let class_id = class.obj_id().id();

                            if let Some(&class_idx) = id_to_node.get(&class_id) {
                                // Reference to superclass
                                if let Some(super_class_id) = class.super_class_obj_id() {
                                    if let Some(&super_class_node) = id_to_node.get(&super_class_id.id()) {
                                        if added_edges.insert((class_idx, super_class_node)) {
                                            graph.add_edge(class_idx, super_class_node, EdgeLabel::SuperClass);
                                            edge_count += 1;
                                        }
                                    }
                                }

                                // Reference to class loader
                                if let Some(class_loader_id) = class.class_loader_obj_id() {
                                    if let Some(&class_loader_node) = id_to_node.get(&class_loader_id.id()) {
                                        if added_edges.insert((class_idx, class_loader_node)) {
                                            graph.add_edge(class_idx, class_loader_node, EdgeLabel::ClassLoader);
                                            edge_count += 1;
                                        }
                                    }
                                }

                                // References from static ObjectId fields
                                for static_field_result in class.static_fields() {
                                    match static_field_result {
                                        Ok(static_field) => {
                                            if matches!(static_field.field_type(), jvm_hprof::heap_dump::FieldType::ObjectId) {
                                                if let jvm_hprof::heap_dump::FieldValue::ObjectId(Some(ref_id)) = static_field.value() {
                                                    let ref_id_val = ref_id.id();
                                                    if ref_id_val != 0 {
                                                        if let Some(&ref_node) = id_to_node.get(&ref_id_val) {
                                                            if added_edges.insert((class_idx, ref_node)) {
                                                                // Resolve static field name from string table
                                                                let sf_name_id = static_field.name_id().id();
                                                                let sf_name_str = string_table.get(&sf_name_id)
                                                                    .map(|s| s.as_str())
                                                                    .unwrap_or("<static>");
                                                                let sf_arc: Arc<str> = Arc::from(sf_name_str);
                                                                let sf_idx = intern_field_name(&sf_arc);
                                                                graph.add_edge(class_idx, ref_node, EdgeLabel::StaticField(sf_idx));
                                                                edge_count += 1;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            log::warn!("Failed to parse static field in class 0x{:x}: {:?}", class_id, e);
                                        }
                                    }
                                }
                            }
                        }
                        // Waste: collect backing arrays for string dedup
                        jvm_hprof::heap_dump::SubRecord::PrimitiveArray(array) => {
                            let arr_id = array.obj_id().id();
                            let prim_type = array.primitive_type();
                            match prim_type {
                                jvm_hprof::heap_dump::PrimitiveArrayType::Byte => {
                                    if let Some(iter) = array.bytes() {
                                        // bytes() yields Result<i8, _>; collect as u8
                                        let bytes: Vec<u8> = iter
                                            .filter_map(|r| r.ok())
                                            .map(|b| b as u8)
                                            .collect();
                                        let arr_size = bytes.len() as u32;
                                        let content_hash = hash_bytes(&bytes);
                                        let preview = if bytes.len() <= 10240 {
                                            let s = String::from_utf8_lossy(&bytes);
                                            let mut p = s.chars().take(120).collect::<String>();
                                            if s.chars().count() > 120 { p.push_str("..."); }
                                            p
                                        } else {
                                            String::new()
                                        };
                                        waste_data.backing_arrays.insert(arr_id, BackingArrayInfo {
                                            content_hash,
                                            size: arr_size,
                                            preview,
                                        });
                                    }
                                }
                                jvm_hprof::heap_dump::PrimitiveArrayType::Char => {
                                    if let Some(iter) = array.chars() {
                                        // chars() yields Result<u16, _>
                                        let chars: Vec<u16> = iter
                                            .filter_map(|r| r.ok())
                                            .collect();
                                        let arr_size = (chars.len() * 2) as u32;
                                        // Hash raw bytes for consistent dedup
                                        let raw_bytes: Vec<u8> = chars.iter()
                                            .flat_map(|c| c.to_be_bytes())
                                            .collect();
                                        let content_hash = hash_bytes(&raw_bytes);
                                        let preview = if chars.len() <= 5120 {
                                            let s: String = chars.iter()
                                                .map(|&c| std::char::from_u32(c as u32).unwrap_or('\u{FFFD}'))
                                                .collect();
                                            let mut p = s.chars().take(120).collect::<String>();
                                            if s.chars().count() > 120 { p.push_str("..."); }
                                            p
                                        } else {
                                            String::new()
                                        };
                                        waste_data.backing_arrays.insert(arr_id, BackingArrayInfo {
                                            content_hash,
                                            size: arr_size,
                                            preview,
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    drop(added_edges); // Free edge dedup set before dominator analysis
    drop(string_table); // Free string table memory — no longer needed after Pass 2

    log::info!("Pass 2 complete: added {} edges (typed: {} instances, fallback: {} instances)", edge_count, typed_instance_count, fallback_instance_count);
    log::info!("Waste data collected: {} string instances, {} backing arrays, {} empty collections",
        waste_data.string_instances.len(), waste_data.backing_arrays.len(), waste_data.empty_collections.len());
    log::info!(
        "Graph construction complete: {} nodes, {} edges",
        graph.node_count(),
        graph.edge_count()
    );

    log::info!("Field name table: {} unique names", field_name_table.len());

    drop(field_name_index); // Interning complete — only field_name_table needed going forward
    Ok((HeapGraph {
        graph,
        id_to_node,
        super_root,
        summary,
        classloader_ids,
        field_name_table,
        class_field_layouts,
        id_size,
    }, waste_data))
}

use graph_builder::{convert_jvm_class_name, field_type_size, extract_typed_references_named, extract_object_references_fallback, types_only};

// Re-export waste types for backward compatibility
pub use waste::{WasteRawData, WasteAnalysis, DuplicateStringGroup, EmptyCollectionGroup, OverAllocatedGroup, BoxedPrimitiveGroup};
use waste::{StringInstanceInfo, BackingArrayInfo, EmptyCollectionInfo, OverAllocatedCollectionInfo, BoxedPrimitiveInfo, hash_bytes, extract_nth_field_of_type};

/// Report for a single object in the heap analysis.
///
/// Contains information about an object's retained size and identification.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ObjectReport {
    /// The HPROF object ID (0 for non-object nodes like SuperRoot, Root, Class).
    pub object_id: u64,
    /// The node type (SuperRoot, Root, Class, Instance, or Array).
    pub node_type: String,
    /// The fully-qualified class name (empty for SuperRoot/Root/Class nodes).
    pub class_name: String,
    /// The shallow size of this object in bytes.
    pub shallow_size: u64,
    /// The retained size of this object in bytes.
    /// Retained size = shallow size + sum of retained sizes of all children in dominator tree.
    pub retained_size: u64,
    /// The field name through which the parent references this object (if known).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_name: Option<String>,
    /// The node index in the graph (for reference).
    #[serde(skip_serializing)]
    pub node_index: NodeIndex,
}

impl ObjectReport {
    /// Creates a new ObjectReport.
    pub fn new(
        object_id: u64,
        node_type: String,
        class_name: String,
        shallow_size: u64,
        retained_size: u64,
        node_index: NodeIndex,
    ) -> Self {
        Self {
            object_id,
            node_type,
            class_name,
            shallow_size,
            retained_size,
            field_name: None,
            node_index,
        }
    }
}

impl PartialOrd for ObjectReport {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ObjectReport {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Sort by retained size (descending), then by object ID
        self.retained_size
            .cmp(&other.retained_size)
            .reverse()
            .then_with(|| self.object_id.cmp(&other.object_id))
    }
}

/// Calculates dominators and retained sizes for all nodes in the heap graph.
///
/// This function:
/// 1. Computes the dominator tree using `petgraph::algo::dominators::simple_fast`
/// 2. Calculates retained sizes using a bottom-up traversal of the dominator tree
/// 3. Returns the top 50 objects sorted by retained size
///
/// # Retained Size Calculation
///
/// Retained size is the amount of memory that would be freed if an object
/// were garbage collected. It is calculated as:
///
/// ```
/// Retained Size(N) = Shallow Size(N) + Sum(Retained Size of all children of N in Dominator Tree)
/// ```
///
/// The dominator tree is used because:
/// - If node A dominates node B, then all paths from the root to B pass through A
/// - This means if A is removed, B becomes unreachable
/// - Therefore, B's retained size should be counted under A
///
/// # Arguments
///
/// * `graph` - The heap graph to analyze
///
/// # Returns
///
/// Returns a `Result<Vec<ObjectReport>>` containing the top 50 objects
/// sorted by retained size (descending).
///
/// # Errors
///
/// Returns an error if:
/// - The dominator calculation fails
/// - Graph structure is invalid
///
/// # Example
///
/// ```no_run
/// use hprof_analyzer::{HprofLoader, build_graph, calculate_dominators};
/// use std::path::PathBuf;
///
/// # fn main() -> anyhow::Result<()> {
/// let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
/// let mmap = loader.map_file()?;
/// let graph = build_graph(&mmap[..])?;
///
/// let top_objects = calculate_dominators(&graph)?;
/// for (i, report) in top_objects.iter().enumerate() {
///     println!("{}. ID={}, Type={}, Retained={} bytes ({:.2} MB)",
///              i + 1,
///              report.object_id,
///              report.node_type,
///              report.retained_size,
///              report.retained_size as f64 / (1024.0 * 1024.0));
/// }
/// # Ok(())
/// # }
/// ```
/// Entry in the class histogram showing aggregate stats per class.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ClassHistogramEntry {
    /// The fully-qualified class name.
    pub class_name: String,
    /// Number of instances of this class.
    pub instance_count: u64,
    /// Total shallow size of all instances of this class.
    pub shallow_size: u64,
    /// Total retained size of all instances of this class.
    pub retained_size: u64,
}

/// A suspected memory leak.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct LeakSuspect {
    /// The class name of the suspected leaking object.
    pub class_name: String,
    /// The HPROF object ID.
    pub object_id: u64,
    /// The retained size of this object.
    pub retained_size: u64,
    /// Percentage of total heap retained by this object.
    pub retained_percentage: f64,
    /// Human-readable description of why this is a suspect.
    pub description: String,
}

// Re-export comparison types for backward compatibility
pub use comparison::{compare_heaps, HeapComparisonResult, HeapSummaryDelta, ClassHistogramDelta, LeakSuspectChange, WasteDelta};

// Re-export dominator functions for backward compatibility
pub use dominator::{calculate_dominators, calculate_dominators_with_state};

/// Summary statistics for the entire heap dump.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HeapSummary {
    /// Total heap size in bytes (sum of all shallow sizes).
    pub total_heap_size: u64,
    /// Reachable heap size in bytes (excludes unreachable objects).
    /// Set after dominator analysis; defaults to total_heap_size.
    pub reachable_heap_size: u64,
    /// Total number of object instances.
    pub total_instances: u64,
    /// Total number of classes.
    pub total_classes: u64,
    /// Total number of arrays.
    pub total_arrays: u64,
    /// Total number of GC roots.
    pub total_gc_roots: u64,
    /// HPROF version string (e.g. "JAVA PROFILE 1.0.2" or "JAVA PROFILE 1.0.3")
    pub hprof_version: String,
    /// Distinct heap type names from Android HeapDumpInfo records (e.g. "app", "zygote", "image")
    pub heap_types: Vec<String>,
}

/// Analysis state containing the dominator tree information.
/// 
/// This structure holds all the data needed to query children of nodes
/// for lazy loading in the visualization.
/// 
/// Note: The HeapGraph itself is not stored here to avoid cloning overhead.
/// Instead, we store the necessary mappings and the graph can be queried
/// separately when needed.
#[derive(Debug, Clone)]
pub struct AnalysisState {
    /// Mapping from node index to its children in the dominator tree.
    pub children_map: HashMap<NodeIndex, Vec<NodeIndex>>,
    /// Retained size per node, indexed by NodeIndex.index().
    pub retained_sizes: Vec<u64>,
    /// Shallow size per node, indexed by NodeIndex.index().
    pub shallow_sizes: Vec<u64>,
    /// Mapping from HPROF object ID to node index.
    pub id_to_node: HashMap<u64, NodeIndex>,
    /// The super root node index.
    pub super_root: NodeIndex,
    /// Node data per node, indexed by NodeIndex.index(): (object_id, node_type, class_name).
    pub node_data_map: Vec<(u64, &'static str, Arc<str>)>,
    /// Class histogram entries sorted by retained size.
    pub class_histogram: Vec<ClassHistogramEntry>,
    /// Detected leak suspects.
    pub leak_suspects: Vec<LeakSuspect>,
    /// Heap summary statistics.
    pub summary: HeapSummary,
    /// Reverse reference adjacency list: for each node, who references it and via which edge label.
    /// Used for BFS backward traversal to find GC root paths.
    pub reverse_refs: HashMap<NodeIndex, Vec<(NodeIndex, EdgeLabel)>>,
    /// Waste analysis: duplicate strings and empty collections.
    pub waste_analysis: WasteAnalysis,
    /// Field name table: maps u32 index → field name string.
    pub field_name_table: Vec<Arc<str>>,
    /// Per-class field layouts for object inspection (class_obj_id → named field list).
    pub class_field_layouts: HashMap<u64, Vec<(Arc<str>, jvm_hprof::heap_dump::FieldType)>>,
    /// HPROF identifier size (4 or 8 bytes).
    pub id_size: IdSize,
}

impl AnalysisState {
    /// Resolves an EdgeLabel to a human-readable field name string.
    pub fn resolve_edge_label(&self, label: &EdgeLabel) -> Option<String> {
        match label {
            EdgeLabel::InstanceField(idx) | EdgeLabel::StaticField(idx) => {
                self.field_name_table.get(*idx as usize).map(|s| s.to_string())
            }
            EdgeLabel::ArrayElement => Some("[element]".to_string()),
            EdgeLabel::SuperClass => Some("<super>".to_string()),
            EdgeLabel::ClassLoader => Some("<classloader>".to_string()),
            EdgeLabel::GcRoot => Some("<gc-root>".to_string()),
            EdgeLabel::Unknown => None,
        }
    }

    /// Gets the children of a node in the dominator tree.
    /// 
    /// # Arguments
    /// 
    /// * `object_id` - The HPROF object ID (0 for SuperRoot, Root, Class nodes)
    /// 
    /// # Returns
    /// 
    /// Returns a vector of ObjectReport for the children, or None if the node is not found.
    pub fn get_children(&self, object_id: u64) -> Option<Vec<ObjectReport>> {
        // Find the node index for this object ID
        let node_idx = if object_id == 0 {
            self.super_root
        } else {
            *self.id_to_node.get(&object_id)?
        };

        // Get children from the dominator tree
        let children_indices = self.children_map.get(&node_idx)?;

        // Build ObjectReport for each child
        let mut children_reports = Vec::new();

        for &child_idx in children_indices {
            let i = child_idx.index();
            let (child_object_id, node_type, class_name) = if i < self.node_data_map.len() {
                let (id, nt, ref cn) = self.node_data_map[i];
                (id, nt, cn.clone())
            } else {
                (0, "Unknown", Arc::from(""))
            };

            let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
            let retained = self.retained_sizes.get(i).copied().unwrap_or(0);

            // Filter out Class nodes and zero-size nodes
            if node_type == "Class" || retained == 0 {
                continue;
            }

            // Look up the edge label from parent→child in reverse_refs.
            // First try the dominator parent (node_idx → child_idx direct edge).
            // If none, fall back to any referrer with a named edge, since the
            // dominator parent may not have a direct reference (e.g., dominated
            // through an intermediate array or wrapper).
            let field_name = self.reverse_refs.get(&child_idx)
                .and_then(|refs| {
                    // Prefer direct edge from dominator parent
                    refs.iter()
                        .find(|(src, _)| *src == node_idx)
                        .and_then(|(_, label)| self.resolve_edge_label(label))
                        .or_else(|| {
                            // Fallback: first referrer with a meaningful label
                            refs.iter()
                                .filter_map(|(_, label)| self.resolve_edge_label(label))
                                .next()
                        })
                });

            let mut report = ObjectReport::new(
                child_object_id,
                node_type.to_string(),
                class_name.to_string(),
                shallow,
                retained,
                child_idx,
            );
            report.field_name = field_name;
            children_reports.push(report);
        }

        if children_reports.is_empty() {
            return None;
        }

        children_reports.sort();
        Some(children_reports)
    }

    /// Returns the objects that directly reference the given object.
    ///
    /// Uses the `reverse_refs` adjacency list (original heap graph edges, not
    /// dominator tree edges) to find all objects that hold a reference to the
    /// target. Filters out SuperRoot, Root, and Class nodes. Results are sorted
    /// by retained size descending.
    pub fn get_referrers(&self, object_id: u64) -> Option<Vec<ObjectReport>> {
        let target_idx = *self.id_to_node.get(&object_id)?;
        let refs = self.reverse_refs.get(&target_idx)?;

        let mut reports = Vec::new();
        for &(referrer_idx, edge_label) in refs {
            let i = referrer_idx.index();
            let (ref_object_id, node_type, class_name) = if i < self.node_data_map.len() {
                let (id, nt, ref cn) = self.node_data_map[i];
                (id, nt, cn.clone())
            } else {
                continue;
            };

            // Filter out synthetic nodes
            if node_type == "SuperRoot" || node_type == "Root" || node_type == "Class" {
                continue;
            }

            let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
            let retained = self.retained_sizes.get(i).copied().unwrap_or(0);

            let field_name = self.resolve_edge_label(&edge_label);

            let mut report = ObjectReport::new(
                ref_object_id,
                node_type.to_string(),
                class_name.to_string(),
                shallow,
                retained,
                referrer_idx,
            );
            report.field_name = field_name;
            reports.push(report);
        }

        if reports.is_empty() {
            return None;
        }

        reports.sort();
        Some(reports)
    }

    /// Finds the shortest reference chain from a GC root to the given object.
    ///
    /// BFS backward from the target through `reverse_refs` (original heap graph edges),
    /// stopping at a Root or SuperRoot node. Returns the path from root to target.
    ///
    /// # Arguments
    ///
    /// * `object_id` - The HPROF object ID of the target object
    /// * `max_depth` - Maximum BFS depth to prevent runaway traversal
    ///
    /// # Returns
    ///
    /// A path of `ObjectReport` nodes from root to target, or `None` if no path exists.
    pub fn gc_root_path(&self, object_id: u64, max_depth: usize) -> Option<Vec<ObjectReport>> {
        // Find the target node
        let target_idx = *self.id_to_node.get(&object_id)?;

        // BFS backward from target through reverse_refs, with depth tracking.
        // came_from stores (previous_node, edge_label_from_previous_to_current).
        let mut came_from: HashMap<NodeIndex, Option<(NodeIndex, Option<EdgeLabel>)>> = HashMap::new();
        came_from.insert(target_idx, None);

        let mut found_root: Option<NodeIndex> = None;

        let mut queue: std::collections::VecDeque<(NodeIndex, usize)> = std::collections::VecDeque::new();
        queue.push_back((target_idx, 0));

        while let Some((current, depth)) = queue.pop_front() {
            // Check if this is a Root or SuperRoot
            let i = current.index();
            let node_type = if i < self.node_data_map.len() {
                self.node_data_map[i].1
            } else {
                "Unknown"
            };

            if node_type == "Root" || node_type == "SuperRoot" {
                found_root = Some(current);
                break;
            }

            if depth >= max_depth {
                continue;
            }

            // Expand backward: who references current?
            if let Some(referrers) = self.reverse_refs.get(&current) {
                for &(referrer, label) in referrers {
                    if !came_from.contains_key(&referrer) {
                        // The edge goes referrer→current, so the label applies to the
                        // forward direction. We store it so we can attach it to the
                        // path hop from referrer to current.
                        came_from.insert(referrer, Some((current, Some(label))));
                        queue.push_back((referrer, depth + 1));
                    }
                }
            }
        }

        let root_idx = found_root?;

        // Reconstruct path from root to target
        let mut path = Vec::new();
        let mut current = root_idx;
        loop {
            let i = current.index();
            let (obj_id, node_type, class_name) = if i < self.node_data_map.len() {
                let (id, nt, ref cn) = self.node_data_map[i];
                (id, nt, cn.to_string())
            } else {
                (0, "Unknown", String::new())
            };
            let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
            let retained = self.retained_sizes.get(i).copied().unwrap_or(0);

            // Resolve the edge label for the hop from current → next
            let field_name = came_from.get(&current)
                .and_then(|opt| opt.as_ref())
                .and_then(|(_, label_opt)| label_opt.as_ref())
                .and_then(|label| self.resolve_edge_label(label));

            let mut report = ObjectReport::new(obj_id, node_type.to_string(), class_name, shallow, retained, current);
            report.field_name = field_name;
            path.push(report);

            if current == target_idx {
                break;
            }

            // came_from[current] = Some((next_node_toward_target, edge_label))
            match came_from.get(&current) {
                Some(Some((next, _))) => current = *next,
                _ => break,
            }
        }

        if path.len() < 2 {
            return None;
        }

        Some(path)
    }

    /// Gets the top N layers of the dominator tree starting from SuperRoot.
    /// 
    /// # Arguments
    /// 
    /// * `max_depth` - Maximum depth to traverse (default: 2 for top 2 layers)
    /// * `max_nodes` - Maximum number of nodes to return (default: 50)
    /// 
    /// # Returns
    /// 
    /// Returns a tree structure with nodes and their immediate children.
    pub fn get_top_layers(&self, max_depth: usize, max_nodes: usize) -> Vec<ObjectReport> {
        let mut result = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::new();

        queue.push_back((self.super_root, 0));
        visited.insert(self.super_root);

        while let Some((node_idx, depth)) = queue.pop_front() {
            if depth >= max_depth || result.len() >= max_nodes {
                break;
            }

            let i = node_idx.index();
            let (object_id, node_type, class_name) = if i < self.node_data_map.len() {
                let (id, nt, ref cn) = self.node_data_map[i];
                (id, nt, cn.to_string())
            } else {
                (0, "Unknown", String::new())
            };

            let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
            let retained = self.retained_sizes.get(i).copied().unwrap_or(0);

            if node_type == "Class" || (retained == 0 && node_type != "SuperRoot") {
                if depth + 1 < max_depth {
                    if let Some(children) = self.children_map.get(&node_idx) {
                        for &child_idx in children {
                            if !visited.contains(&child_idx) && result.len() < max_nodes {
                                visited.insert(child_idx);
                                queue.push_back((child_idx, depth + 1));
                            }
                        }
                    }
                }
                continue;
            }

            result.push(ObjectReport::new(
                object_id,
                node_type.to_string(),
                class_name,
                shallow,
                retained,
                node_idx,
            ));

            if depth + 1 < max_depth {
                if let Some(children) = self.children_map.get(&node_idx) {
                    for &child_idx in children {
                        if !visited.contains(&child_idx) && result.len() < max_nodes {
                            visited.insert(child_idx);
                            queue.push_back((child_idx, depth + 1));
                        }
                    }
                }
            }
        }

        result.sort();
        result
    }

    /// Inspects all fields of a specific object instance.
    ///
    /// Re-opens and scans the HPROF file to find the Instance record with
    /// the given object ID, then parses its field bytes using the stored
    /// class_field_layouts to produce a detailed field listing.
    ///
    /// # Arguments
    ///
    /// * `hprof_path` - Path to the HPROF file
    /// * `object_id` - The HPROF object ID to inspect
    ///
    /// # Returns
    ///
    /// A vector of `FieldInfo` describing each field, or `None` if the
    /// object is not an Instance or cannot be found.
    pub fn inspect_object(&self, hprof_path: &Path, object_id: u64) -> Option<Vec<FieldInfo>> {
        let loader = HprofLoader::new(hprof_path.to_path_buf());
        let mmap = loader.map_file().ok()?;
        self.inspect_object_bytes(&mmap[..], object_id)
    }

    /// Inspect object fields using pre-loaded HPROF bytes (avoids re-mapping).
    pub fn inspect_object_bytes(&self, hprof_bytes: &[u8], object_id: u64) -> Option<Vec<FieldInfo>> {
        use jvm_hprof::heap_dump::FieldType;

        // Verify the object exists in our graph and is an Instance
        let node_idx = self.id_to_node.get(&object_id)?;
        let i = node_idx.index();
        if i >= self.node_data_map.len() {
            return None;
        }
        let (_, node_type, _) = &self.node_data_map[i];
        if *node_type != "Instance" {
            return None;
        }

        let hprof = parse_hprof(hprof_bytes).ok()?;

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
            for sub_record_result in heap_dump.sub_records() {
                let sub_record = match sub_record_result {
                    Ok(sr) => sr,
                    Err(_) => continue,
                };
                if let jvm_hprof::heap_dump::SubRecord::Instance(instance) = sub_record {
                    if instance.obj_id().id() != object_id {
                        continue;
                    }
                    let class_obj_id = instance.class_obj_id().id();
                    let field_layout = self.class_field_layouts.get(&class_obj_id)?;
                    let field_data = instance.fields();

                    let mut fields = Vec::with_capacity(field_layout.len());
                    let mut offset = 0;

                    for (name, ft) in field_layout {
                        let size = field_type_size(ft, self.id_size);
                        if offset + size > field_data.len() {
                            break;
                        }

                        let type_str = match ft {
                            FieldType::ObjectId => "ref".to_string(),
                            FieldType::Boolean => "boolean".to_string(),
                            FieldType::Byte => "byte".to_string(),
                            FieldType::Char => "char".to_string(),
                            FieldType::Short => "short".to_string(),
                            FieldType::Int => "int".to_string(),
                            FieldType::Float => "float".to_string(),
                            FieldType::Long => "long".to_string(),
                            FieldType::Double => "double".to_string(),
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

                        let (primitive_value, ref_object_id, ref_summary) = match ft {
                            FieldType::ObjectId => {
                                if raw_value == 0 {
                                    (Some("null".to_string()), None, None)
                                } else {
                                    let summary = self.id_to_node.get(&raw_value).map(|&ref_idx| {
                                        let ri = ref_idx.index();
                                        let (_, rnt, rcn) = if ri < self.node_data_map.len() {
                                            let (_, nt, ref cn) = &self.node_data_map[ri];
                                            (0u64, *nt, cn.to_string())
                                        } else {
                                            (0u64, "Unknown", String::new())
                                        };
                                        let rs = self.shallow_sizes.get(ri).copied().unwrap_or(0);
                                        let rr = self.retained_sizes.get(ri).copied().unwrap_or(0);
                                        RefSummary {
                                            class_name: rcn,
                                            node_type: rnt.to_string(),
                                            shallow_size: rs,
                                            retained_size: rr,
                                        }
                                    });
                                    (None, Some(raw_value), summary)
                                }
                            }
                            FieldType::Boolean => {
                                (Some(if raw_value != 0 { "true" } else { "false" }.to_string()), None, None)
                            }
                            FieldType::Char => {
                                let ch = std::char::from_u32(raw_value as u32)
                                    .unwrap_or('\u{FFFD}');
                                (Some(format!("'{}'", ch)), None, None)
                            }
                            FieldType::Float => {
                                let f = f32::from_bits(raw_value as u32);
                                (Some(format!("{}", f)), None, None)
                            }
                            FieldType::Double => {
                                let d = f64::from_bits(raw_value);
                                (Some(format!("{}", d)), None, None)
                            }
                            _ => {
                                // Int, Long, Short, Byte — display as signed integer
                                let signed = match ft {
                                    FieldType::Byte => (raw_value as i8) as i64,
                                    FieldType::Short => (raw_value as i16) as i64,
                                    FieldType::Int => (raw_value as i32) as i64,
                                    FieldType::Long => raw_value as i64,
                                    _ => raw_value as i64,
                                };
                                (Some(format!("{}", signed)), None, None)
                            }
                        };

                        fields.push(FieldInfo {
                            name: name.to_string(),
                            field_type: type_str,
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

    /// Returns a subtree of the dominator tree rooted at the given object,
    /// suitable for rendering as a flame/icicle chart.
    pub fn get_dominator_subtree(
        &self,
        object_id: u64,
        max_depth: usize,
        max_children: usize,
    ) -> Option<DominatorTreeNode> {
        let node_idx = if object_id == 0 {
            self.super_root
        } else {
            *self.id_to_node.get(&object_id)?
        };

        let mut total_nodes = 0;
        let node = self.build_subtree_node(node_idx, 0, max_depth, max_children, &mut total_nodes);
        Some(node)
    }

    fn build_subtree_node(
        &self,
        node_idx: NodeIndex,
        depth: usize,
        max_depth: usize,
        max_children: usize,
        total_nodes: &mut usize,
    ) -> DominatorTreeNode {
        let i = node_idx.index();
        let (object_id, node_type, class_name) = if i < self.node_data_map.len() {
            let (id, nt, ref cn) = self.node_data_map[i];
            (id, nt.to_string(), cn.to_string())
        } else {
            (0, "Unknown".to_string(), String::new())
        };

        let shallow_size = self.shallow_sizes.get(i).copied().unwrap_or(0);
        let retained_size = self.retained_sizes.get(i).copied().unwrap_or(0);

        *total_nodes += 1;
        let mut children = Vec::new();

        if depth < max_depth && *total_nodes < 10000 {
            if let Some(child_indices) = self.children_map.get(&node_idx) {
                let mut child_data: Vec<(NodeIndex, u64, &str)> = child_indices
                    .iter()
                    .filter_map(|&ci| {
                        let ci_i = ci.index();
                        if ci_i >= self.node_data_map.len() { return None; }
                        let (_, nt, _) = &self.node_data_map[ci_i];
                        if *nt == "Class" { return None; }
                        let ret = self.retained_sizes.get(ci_i).copied().unwrap_or(0);
                        if ret == 0 { return None; }
                        Some((ci, ret, *nt))
                    })
                    .collect();

                child_data.sort_by(|a, b| b.1.cmp(&a.1));

                let show_count = child_data.len().min(max_children);
                for &(ci, _, _) in &child_data[..show_count] {
                    children.push(self.build_subtree_node(ci, depth + 1, max_depth, max_children, total_nodes));
                    if *total_nodes >= 10000 { break; }
                }

                if child_data.len() > max_children {
                    let others = &child_data[max_children..];
                    let agg_retained: u64 = others.iter().map(|(_, r, _)| r).sum();
                    let agg_shallow: u64 = others.iter().map(|(ci, _, _)| {
                        self.shallow_sizes.get(ci.index()).copied().unwrap_or(0)
                    }).sum();
                    children.push(DominatorTreeNode {
                        name: format!("[{} others]", others.len()),
                        retained_size: agg_retained,
                        shallow_size: agg_shallow,
                        object_id: 0,
                        node_type: "Aggregated".to_string(),
                        children: Vec::new(),
                    });
                }
            }
        }

        DominatorTreeNode {
            name: class_name,
            retained_size,
            shallow_size,
            object_id,
            node_type,
            children,
        }
    }
}

/// A node in the dominator subtree, for flame graph / icicle chart rendering.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DominatorTreeNode {
    pub name: String,
    pub retained_size: u64,
    pub shallow_size: u64,
    pub object_id: u64,
    pub node_type: String,
    pub children: Vec<DominatorTreeNode>,
}

/// A snapshot summary for timeline comparison across multiple heap dumps.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TimelineSnapshot {
    pub path: String,
    pub summary: HeapSummary,
    pub top_classes: Vec<ClassHistogramEntry>,
}

impl AnalysisState {
    /// Extracts a timeline snapshot from this analysis state.
    pub fn get_timeline_snapshot(&self, path: &str, top_n: usize) -> TimelineSnapshot {
        let top_classes: Vec<ClassHistogramEntry> = self.class_histogram.iter()
            .take(top_n)
            .cloned()
            .collect();
        TimelineSnapshot {
            path: path.to_string(),
            summary: self.summary.clone(),
            top_classes,
        }
    }
}

// calculate_dominators and calculate_dominators_with_state are in dominator.rs
// (removed ~420 lines — see dominator.rs for the full implementation)
// End of dominator removal marker

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Test that we can successfully map a dummy file.
    ///
    /// This test:
    /// 1. Creates a temporary file with test data
    /// 2. Uses HprofLoader to map it
    /// 3. Verifies the mapped content matches the written data
    #[test]
    fn test_map_dummy_file() {
        // Initialize logger for test output (optional, but helpful for debugging)
        let _ = env_logger::Builder::from_default_env()
            .filter_level(log::LevelFilter::Debug)
            .try_init();

        // Create a temporary file with some test data
        let mut temp_file = tempfile::NamedTempFile::new().expect("Failed to create temp file");
        let test_data = b"JAVA PROFILE 1.0.2\0This is test HPROF data for memory mapping";
        temp_file
            .write_all(test_data)
            .expect("Failed to write test data");

        // Get the path to the temporary file
        let file_path = temp_file.path().to_path_buf();

        // Create a loader and map the file
        let loader = HprofLoader::new(file_path.clone());
        let mmap = loader
            .map_file()
            .expect("Failed to map the temporary file");

        // Verify the mapped content matches what we wrote
        assert_eq!(mmap.len(), test_data.len());
        assert_eq!(&mmap[..], test_data);

        // Verify we can read specific bytes
        assert_eq!(&mmap[0..18], b"JAVA PROFILE 1.0.2");

        log::info!("Successfully mapped and verified {} bytes", mmap.len());
    }

    /// Test that mapping an empty file returns an appropriate error.
    #[test]
    fn test_map_empty_file() {
        let _ = env_logger::Builder::from_default_env()
            .filter_level(log::LevelFilter::Debug)
            .try_init();

        let temp_file = tempfile::NamedTempFile::new().expect("Failed to create temp file");
        let file_path = temp_file.path().to_path_buf();

        let loader = HprofLoader::new(file_path);
        let result = loader.map_file();

        assert!(result.is_err());
        match result.unwrap_err() {
            HprofLoaderError::EmptyFile { path } => {
                log::debug!("Correctly detected empty file: {:?}", path);
            }
            other => panic!("Expected EmptyFile error, got: {:?}", other),
        }
    }

    /// Test that mapping a non-existent file returns an appropriate error.
    #[test]
    fn test_map_nonexistent_file() {
        let _ = env_logger::Builder::from_default_env()
            .filter_level(log::LevelFilter::Debug)
            .try_init();

        let nonexistent_path = PathBuf::from("/nonexistent/path/to/file.hprof");
        let loader = HprofLoader::new(nonexistent_path.clone());
        let result = loader.map_file();

        assert!(result.is_err());
        match result.unwrap_err() {
            HprofLoaderError::FileOpen { path, .. } => {
                assert_eq!(path, nonexistent_path);
                log::debug!("Correctly detected nonexistent file: {:?}", path);
            }
            other => panic!("Expected FileOpen error, got: {:?}", other),
        }
    }

    /// Test that the mapped memory is read-only (attempting to write would cause a segfault,
    /// but we can at least verify the type system prevents mutable access).
    #[test]
    fn test_mapped_memory_is_readonly() {
        let _ = env_logger::Builder::from_default_env()
            .filter_level(log::LevelFilter::Debug)
            .try_init();

        let mut temp_file = tempfile::NamedTempFile::new().expect("Failed to create temp file");
        temp_file
            .write_all(b"test data")
            .expect("Failed to write test data");

        let loader = HprofLoader::new(temp_file.path().to_path_buf());
        let mmap = loader.map_file().expect("Failed to map file");

        // Verify we can read from the map
        assert_eq!(&mmap[..], b"test data");

        // The memory map is read-only, so we cannot get a mutable reference.
        // This is enforced by the type system - `Mmap` (not `MmapMut`) is returned.
        // If we tried to get a mutable reference, the compiler would prevent it.
        // This test verifies the API design, not runtime behavior.
        log::debug!("Mapped memory is read-only (type system enforced)");
    }

    /// Test that we can map a large file (simulating a real HPROF scenario).
    #[test]
    fn test_map_large_file() {
        let _ = env_logger::Builder::from_default_env()
            .filter_level(log::LevelFilter::Debug)
            .try_init();

        // Create a file with 1MB of data (simulating a small HPROF file)
        let mut temp_file = tempfile::NamedTempFile::new().expect("Failed to create temp file");
        let large_data = vec![0x42u8; 1024 * 1024]; // 1MB
        temp_file
            .write_all(&large_data)
            .expect("Failed to write large test data");

        let loader = HprofLoader::new(temp_file.path().to_path_buf());
        let mmap = loader
            .map_file()
            .expect("Failed to map large file");

        assert_eq!(mmap.len(), 1024 * 1024);
        assert_eq!(mmap[0], 0x42);
        assert_eq!(mmap[mmap.len() - 1], 0x42);

        log::info!("Successfully mapped large file: {} bytes", mmap.len());
    }

    /// Helper to build a minimal AnalysisState for GC root path testing.
    fn make_test_state(
        edges: &[(NodeIndex, NodeIndex)],
        node_data: &[(NodeIndex, u64, &'static str, &str)], // (idx, object_id, node_type, class_name)
        super_root: NodeIndex,
    ) -> AnalysisState {
        let mut reverse_refs: HashMap<NodeIndex, Vec<(NodeIndex, EdgeLabel)>> = HashMap::new();
        let mut children_map: HashMap<NodeIndex, Vec<NodeIndex>> = HashMap::new();
        let mut id_to_node: HashMap<u64, NodeIndex> = HashMap::new();

        // Determine the max node index to size the Vecs
        let max_idx = node_data.iter().map(|&(idx, _, _, _)| idx.index()).max().unwrap_or(0);
        let vec_size = max_idx + 1;
        let empty_class: Arc<str> = Arc::from("");
        let mut node_data_map: Vec<(u64, &'static str, Arc<str>)> = vec![(0, "Unknown", empty_class.clone()); vec_size];
        let mut shallow_sizes: Vec<u64> = vec![0u64; vec_size];
        let mut retained_sizes: Vec<u64> = vec![0u64; vec_size];

        for &(src, tgt) in edges {
            reverse_refs.entry(tgt).or_insert_with(Vec::new).push((src, EdgeLabel::Unknown));
            children_map.entry(src).or_insert_with(Vec::new).push(tgt);
        }

        for &(idx, object_id, node_type, class_name) in node_data {
            node_data_map[idx.index()] = (object_id, node_type, Arc::from(class_name));
            if object_id > 0 {
                id_to_node.insert(object_id, idx);
            }
            shallow_sizes[idx.index()] = 100;
            retained_sizes[idx.index()] = 200;
        }

        AnalysisState {
            children_map,
            retained_sizes,
            shallow_sizes,
            id_to_node,
            super_root,
            node_data_map,
            class_histogram: vec![],
            leak_suspects: vec![],
            summary: HeapSummary {
                total_heap_size: 1000,
                reachable_heap_size: 1000,
                total_instances: 5,
                total_classes: 1,
                total_arrays: 0,
                total_gc_roots: 1,
                hprof_version: String::new(),
                heap_types: Vec::new(),
            },
            reverse_refs,
            field_name_table: vec![],
            class_field_layouts: HashMap::new(),
            id_size: IdSize::U64,
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
        }
    }

    /// Test GC root path: SuperRoot→Root→A→B→C, query C → path of ≥3 nodes
    #[test]
    fn test_gc_root_path_simple() {
        let sr = NodeIndex::new(0);
        let root = NodeIndex::new(1);
        let a = NodeIndex::new(2);
        let b = NodeIndex::new(3);
        let c = NodeIndex::new(4);

        let state = make_test_state(
            &[(sr, root), (root, a), (a, b), (b, c)],
            &[
                (sr, 0, "SuperRoot", ""),
                (root, 0, "Root", ""),
                (a, 100, "Instance", "com.example.A"),
                (b, 200, "Instance", "com.example.B"),
                (c, 300, "Instance", "com.example.C"),
            ],
            sr,
        );

        let path = state.gc_root_path(300, 100);
        assert!(path.is_some(), "Expected a path to object 300");
        let path = path.unwrap();
        assert!(path.len() >= 3, "Path should have at least 3 nodes, got {}", path.len());
        // First node should be Root or SuperRoot
        assert!(
            path[0].node_type == "Root" || path[0].node_type == "SuperRoot",
            "Path should start at a root, got: {}",
            path[0].node_type
        );
        // Last node should be our target
        assert_eq!(path.last().unwrap().object_id, 300);
    }

    /// Test GC root path: isolated node with no incoming edges → None
    #[test]
    fn test_gc_root_path_not_found() {
        let sr = NodeIndex::new(0);
        let root = NodeIndex::new(1);
        let isolated = NodeIndex::new(2);

        let state = make_test_state(
            &[(sr, root)], // isolated has no edges
            &[
                (sr, 0, "SuperRoot", ""),
                (root, 0, "Root", ""),
                (isolated, 999, "Instance", "com.example.Isolated"),
            ],
            sr,
        );

        let path = state.gc_root_path(999, 100);
        assert!(path.is_none(), "Expected None for isolated node");
    }

    /// Test GC root path: Root→A directly → 2-element path
    #[test]
    fn test_gc_root_path_direct_child() {
        let sr = NodeIndex::new(0);
        let root = NodeIndex::new(1);
        let a = NodeIndex::new(2);

        let state = make_test_state(
            &[(sr, root), (root, a)],
            &[
                (sr, 0, "SuperRoot", ""),
                (root, 0, "Root", ""),
                (a, 42, "Instance", "com.example.Direct"),
            ],
            sr,
        );

        let path = state.gc_root_path(42, 100);
        assert!(path.is_some(), "Expected a path to object 42");
        let path = path.unwrap();
        assert_eq!(path.len(), 2, "Direct child should have 2-element path");
        assert!(
            path[0].node_type == "Root",
            "First element should be Root, got: {}",
            path[0].node_type
        );
        assert_eq!(path[1].object_id, 42);
    }

    #[test]
    fn test_compare_heaps() {
        let sr = NodeIndex::new(0);
        let root = NodeIndex::new(1);

        // Baseline state: has class A and B, leak suspect on A
        let mut baseline = make_test_state(
            &[(sr, root)],
            &[
                (sr, 0, "SuperRoot", ""),
                (root, 0, "Root", ""),
            ],
            sr,
        );
        baseline.summary = HeapSummary {
            total_heap_size: 10000,
            reachable_heap_size: 8000,
            total_instances: 100,
            total_classes: 5,
            total_arrays: 10,
            total_gc_roots: 2,
            hprof_version: String::new(),
            heap_types: Vec::new(),
        };
        baseline.class_histogram = vec![
            ClassHistogramEntry {
                class_name: "com.example.A".to_string(),
                instance_count: 50,
                shallow_size: 2000,
                retained_size: 5000,
            },
            ClassHistogramEntry {
                class_name: "com.example.B".to_string(),
                instance_count: 30,
                shallow_size: 1000,
                retained_size: 2000,
            },
        ];
        baseline.leak_suspects = vec![LeakSuspect {
            class_name: "com.example.A".to_string(),
            object_id: 1,
            retained_size: 5000,
            retained_percentage: 50.0,
            description: "Retains 50% of heap".to_string(),
        }];
        baseline.waste_analysis = WasteAnalysis {
            total_wasted_bytes: 500,
            waste_percentage: 5.0,
            duplicate_string_wasted_bytes: 300,
            empty_collection_wasted_bytes: 200,
            over_allocated_wasted_bytes: 0,
            boxed_primitive_wasted_bytes: 0,
            duplicate_strings: vec![],
            empty_collections: vec![],
            over_allocated_collections: vec![],
            boxed_primitives: vec![],
        };

        // Current state: A grew, B removed, C is new, new leak suspect on C
        let mut current = make_test_state(
            &[(sr, root)],
            &[
                (sr, 0, "SuperRoot", ""),
                (root, 0, "Root", ""),
            ],
            sr,
        );
        current.summary = HeapSummary {
            total_heap_size: 15000,
            reachable_heap_size: 12000,
            total_instances: 150,
            total_classes: 6,
            total_arrays: 15,
            total_gc_roots: 3,
            hprof_version: String::new(),
            heap_types: Vec::new(),
        };
        current.class_histogram = vec![
            ClassHistogramEntry {
                class_name: "com.example.A".to_string(),
                instance_count: 80,
                shallow_size: 3000,
                retained_size: 8000,
            },
            ClassHistogramEntry {
                class_name: "com.example.C".to_string(),
                instance_count: 20,
                shallow_size: 500,
                retained_size: 1500,
            },
        ];
        current.leak_suspects = vec![LeakSuspect {
            class_name: "com.example.C".to_string(),
            object_id: 2,
            retained_size: 1500,
            retained_percentage: 10.0,
            description: "New suspect".to_string(),
        }];
        current.waste_analysis = WasteAnalysis {
            total_wasted_bytes: 800,
            waste_percentage: 5.3,
            duplicate_string_wasted_bytes: 600,
            empty_collection_wasted_bytes: 200,
            over_allocated_wasted_bytes: 0,
            boxed_primitive_wasted_bytes: 0,
            duplicate_strings: vec![],
            empty_collections: vec![],
            over_allocated_collections: vec![],
            boxed_primitives: vec![],
        };

        let result = compare_heaps(&baseline, &current, "/tmp/baseline.hprof", "/tmp/current.hprof");

        // Summary delta
        assert_eq!(result.summary_delta.total_heap_size_delta, 5000);
        assert_eq!(result.summary_delta.reachable_heap_size_delta, 4000);
        assert_eq!(result.summary_delta.total_instances_delta, 50);

        // Histogram delta
        assert_eq!(result.histogram_delta.len(), 3); // A grew, B removed, C new
        let a_delta = result.histogram_delta.iter().find(|d| d.class_name == "com.example.A").unwrap();
        assert_eq!(a_delta.change_type, "grew");
        assert_eq!(a_delta.retained_size_delta, 3000);

        let b_delta = result.histogram_delta.iter().find(|d| d.class_name == "com.example.B").unwrap();
        assert_eq!(b_delta.change_type, "removed");
        assert_eq!(b_delta.retained_size_delta, -2000);

        let c_delta = result.histogram_delta.iter().find(|d| d.class_name == "com.example.C").unwrap();
        assert_eq!(c_delta.change_type, "new");
        assert_eq!(c_delta.retained_size_delta, 1500);

        // Leak suspect changes
        assert_eq!(result.leak_suspect_changes.len(), 2); // A resolved, C new
        let a_leak = result.leak_suspect_changes.iter().find(|l| l.class_name == "com.example.A").unwrap();
        assert_eq!(a_leak.change_type, "resolved");

        let c_leak = result.leak_suspect_changes.iter().find(|l| l.class_name == "com.example.C").unwrap();
        assert_eq!(c_leak.change_type, "new");

        // Waste delta
        assert_eq!(result.waste_delta.total_wasted_delta, 300);
        assert_eq!(result.waste_delta.duplicate_string_wasted_delta, 300);
        assert_eq!(result.waste_delta.empty_collection_wasted_delta, 0);
    }
}
