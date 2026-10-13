//! Explicit versioned node records and metadata; never serialize pointers.
use super::{
    node_store::{NodeStore, NodeType},
    parse::Phase1Result,
};
use anyhow::{ensure, Result};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufReader, Read, Write},
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
const RECORD_BYTES: u64 = 25;

pub(crate) fn write(
    phase: &Phase1Result,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<super::cache_writer::Receipt>> {
    let mut names = Vec::new();
    let mut indices: HashMap<Arc<str>, u32> = HashMap::new();
    let mut writer = super::cache_writer::CacheWriter::new(directory, "nodes.bin", cancel)?;
    for node in phase.node_store.iter() {
        let index = if let Some(&index) = indices.get(&node.class_name) {
            index
        } else {
            let index = u32::try_from(names.len())?;
            names.push(node.class_name.clone());
            indices.insert(node.class_name.clone(), index);
            index
        };
        writer.write_all(&node.id.to_le_bytes())?;
        writer.write_all(&node.shallow_size.to_le_bytes())?;
        writer.write_all(&node.class_index.to_le_bytes())?;
        writer.write_all(&index.to_le_bytes())?;
        writer.write_all(&[node.node_type as u8])?;
    }
    Ok(vec![
        writer.finish()?,
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
    let node_file = File::open(directory.join("nodes.bin"))?;
    ensure!(
        node_file.metadata()?.len()
            == (metadata.nodes as u64)
                .checked_mul(RECORD_BYTES)
                .ok_or_else(|| anyhow::anyhow!("Invalid node count"))?,
        "Invalid node file length"
    );
    let names = metadata.names;
    let mut nodes = NodeStore::with_capacity(metadata.nodes);
    let mut reader = BufReader::new(node_file);
    for index in 0..metadata.nodes {
        if index % 4096 == 0 {
            super::disk_edges::check(cancel)?;
        }
        let mut bytes = [0u8; RECORD_BYTES as usize];
        reader.read_exact(&mut bytes)?;
        let id = u64::from_le_bytes(bytes[..8].try_into()?);
        let size = u64::from_le_bytes(bytes[8..16].try_into()?);
        let class = u32::from_le_bytes(bytes[16..20].try_into()?);
        let name = u32::from_le_bytes(bytes[20..24].try_into()?);
        let kind = match bytes[24] {
            0 => NodeType::SuperRoot,
            1 => NodeType::GcRoot,
            2 => NodeType::Class,
            3 => NodeType::Instance,
            4 => NodeType::ObjectArray,
            5 => NodeType::PrimitiveArray,
            _ => anyhow::bail!("Invalid node type"),
        };
        ensure!(
            (index == 0) == (kind == NodeType::SuperRoot) && (index != 0 || id == 0),
            "Invalid super root"
        );
        let name = names
            .get(name as usize)
            .ok_or_else(|| anyhow::anyhow!("Invalid class name index"))?;
        ensure!(
            nodes.add_node(id, class, size, kind, name.clone()) as usize == index,
            "Duplicate cached object ID"
        );
    }
    ensure!(
        metadata
            .gc_root_ids
            .iter()
            .all(|&id| nodes.index_of(id).is_some()),
        "Invalid cached GC root"
    );
    for &id in metadata
        .classloader_ids
        .iter()
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
    {
        ensure!(
            nodes.index_of(id).is_some(),
            "Invalid cached object metadata ID"
        );
    }
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
