//! Explicit versioned node records and metadata; never serialize pointers.
use super::{node_store::NodeStore, parse::Phase1Result};
use anyhow::{ensure, Result};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

pub(crate) fn write(
    phase: &Phase1Result,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<super::cache_writer::Receipt>> {
    let (receipt, names) = super::compact_nodes::write(&phase.node_store, directory, cancel)?;
    Ok(vec![
        receipt,
        super::cache_metadata::write(phase, names, directory, cancel)?,
    ])
}
pub(crate) fn read(
    directory: &Path,
    mapping: Arc<memmap2::Mmap>,
    cancel: &AtomicBool,
) -> Result<Phase1Result> {
    let mut metadata = super::cache_metadata::read(directory, mapping, cancel)?;
    ensure!(
        metadata.nodes > 0 && metadata.nodes < u32::MAX as usize,
        "Invalid node count"
    );
    let nodes = NodeStore::mapped(super::compact_nodes::MappedNodes::map(
        directory,
        metadata.names,
        metadata.nodes,
        cancel,
    )?);
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
        waste_raw: metadata.waste_raw,
        class_histogram: Vec::new(),
    })
}
