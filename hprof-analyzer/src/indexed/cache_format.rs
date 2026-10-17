//! Explicit versioned node records and metadata; never serialize pointers.
use super::{node_store::NodeStore, parse::Phase1Result};
use anyhow::{ensure, Result};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

pub(crate) fn write(
    phase: &mut Phase1Result,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<super::cache_writer::Receipt>> {
    let (receipt, names) = super::compact_nodes::write(&phase.node_store, directory, cancel)?;
    // Release mutable construction files and their private temporary directories
    // before publication. The first analysis uses the same compact reader as reuse.
    let mut frozen = NodeStore::mapped(super::compact_nodes::MappedNodes::map(
        directory,
        names.clone(),
        phase.node_store.len(),
        cancel,
    )?);
    phase.node_store.transfer_resource_to(&mut frozen);
    phase.node_store = frozen;
    let mut receipts = vec![receipt];
    receipts.extend(super::cache_metadata::write_mapped(
        phase, names, directory, cancel,
    )?);
    Ok(receipts)
}
pub(crate) fn read(
    directory: &Path,
    mapping: Arc<memmap2::Mmap>,
    cancel: &AtomicBool,
) -> Result<Phase1Result> {
    // Header inspection precedes metadata expansion. Full persisted-byte
    // verification has already run in structural_cache::read.
    use std::io::Read;
    let mut file = std::fs::File::open(directory.join("metadata.bin"))?;
    let mut header = [0; 12];
    file.read_exact(&mut header)?;
    ensure!(&header[..8] == b"HLMETA04", "Unsupported metadata format");
    let count = u32::from_le_bytes(header[8..].try_into()?) as usize;
    let resource = super::resource_lease::Lease::acquire(super::resource_plan::Plan::reopen(
        count,
        file.metadata()?.len(),
    )?)?;
    let mut metadata = super::cache_metadata::read(directory, mapping, cancel)?;
    ensure!(
        metadata.nodes > 0 && metadata.nodes < u32::MAX as usize,
        "Invalid node count"
    );
    let mut nodes = NodeStore::mapped(super::compact_nodes::MappedNodes::map(
        directory,
        metadata.names,
        metadata.nodes,
        cancel,
    )?);
    nodes.set_resource(Some(resource));
    nodes.validate_ids(
        metadata
            .gc_root_ids
            .iter()
            .chain(metadata.classloader_ids.iter())
            .chain(metadata.waste_raw.array_element_counts.keys())
            .chain(
                metadata
                    .waste_raw
                    .lazy_contents
                    .as_ref()
                    .unwrap()
                    .arrays
                    .keys(),
            )
            .copied(),
        cancel,
    )?;
    validate_array_catalog(
        &nodes,
        metadata.waste_raw.mapped_arrays.as_ref().unwrap(),
        cancel,
    )?;
    for (&id, _) in metadata.class_index.entries() {
        ensure!(nodes.index_of(id).is_some(), "Invalid cached class ID");
    }
    ensure!(
        metadata.waste_raw.backing_arrays.is_empty(),
        "Unexpected content cache"
    );
    metadata.class_index.resolve_field_layouts();
    Ok(Phase1Result {
        node_store: nodes,
        class_index: metadata.class_index,
        string_table: metadata.string_table,
        gc_root_ids: metadata.gc_root_ids,
        classloader_ids: metadata.classloader_ids,
        summary: metadata.summary,
        waste_raw: Arc::new(metadata.waste_raw),
        class_histogram: Vec::new(),
    })
}

fn validate_array_catalog(
    nodes: &NodeStore,
    catalog: &super::array_catalog::ArrayCatalog,
    cancel: &AtomicBool,
) -> Result<()> {
    let _timer = super::stage_timer::StageTimer::start("index.array_catalog_ids");
    let mut rank = 0usize;
    for i in 0..catalog.len() {
        if i % 4096 == 0 {
            super::disk_edges::check(cancel)?;
        }
        let id = catalog.id_at(i);
        while rank < nodes.len() && nodes.id_at(nodes.mapped_id_order_index(rank as u32)) < id {
            rank += 1;
            if rank % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
        }
        ensure!(rank < nodes.len(), "Invalid cached array ID");
        let index = nodes.mapped_id_order_index(rank as u32);
        ensure!(
            nodes.id_at(index) == id
                && matches!(
                    nodes.kind_at(index),
                    super::node_store::NodeType::ObjectArray
                        | super::node_store::NodeType::PrimitiveArray
                ),
            "Invalid cached array ID"
        );
        if catalog.row_at(i)[3] == 1 {
            ensure!(
                nodes.kind_at(index) == super::node_store::NodeType::PrimitiveArray,
                "Invalid primitive content owner"
            );
        }
    }
    Ok(())
}
pub(crate) fn freeze_waste(
    phase: &mut Phase1Result,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let _timer = super::stage_timer::StageTimer::start("index.freeze_waste");
    let input_bytes = phase
        .waste_raw
        .lazy_contents
        .as_ref()
        .unwrap()
        .mapping
        .len();
    let catalog = super::array_catalog::ArrayCatalog::map(
        directory,
        phase.node_store.len(),
        input_bytes,
        cancel,
    )?;
    validate_array_catalog(&phase.node_store, &catalog, cancel)?;
    let raw = Arc::get_mut(&mut phase.waste_raw)
        .ok_or_else(|| anyhow::anyhow!("Shared mutable Waste candidates during freeze"))?;
    let mapping = raw.lazy_contents.as_ref().unwrap().mapping.clone();
    raw.array_element_counts = std::collections::HashMap::new();
    raw.lazy_contents = Some(Arc::new(super::waste::LazyStringContents::new(
        mapping,
        std::collections::HashMap::new(),
    )));
    raw.mapped_arrays = Some(Arc::new(catalog));
    Ok(())
}
