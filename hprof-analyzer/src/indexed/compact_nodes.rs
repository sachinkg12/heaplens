//! Immutable, independently validated node columns. Compression is confined to
//! metadata; CSR targets and traversal offsets retain their existing layout.
#[cfg(test)]
use super::node_store::NodeRecord;
use super::{
    cache_writer::{CacheWriter, Receipt},
    column::Column,
    node_store::{NodeStore, NodeType},
};
use anyhow::{ensure, Result};
use std::{
    io::Write,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
const MAGIC: &[u8; 8] = b"HLNODE02";
const BLOCK: usize = 256;
const DESCRIPTOR: usize = 17;
const COLUMNS: usize = 6;

#[derive(Debug, Clone, Copy, Default)]
struct Packed {
    descriptors: usize,
    payload: usize,
}
#[derive(Debug, Clone)]
pub(crate) struct MappedNodes {
    bytes: Column<u8>,
    columns: [Packed; COLUMNS],
    names: Vec<Arc<str>>,
    count: usize,
}
fn word(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().unwrap())
}
fn width(delta: u64) -> usize {
    match delta {
        0 => 0,
        1..=255 => 1,
        256..=65535 => 2,
        65536..=4294967295 => 4,
        _ => 8,
    }
}
fn encode_column(
    out: &mut CacheWriter<'_>,
    count: usize,
    value: impl Fn(usize) -> u64,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut descriptors = Vec::new();
    let mut size = 0u64;
    for start in (0..count).step_by(BLOCK) {
        super::disk_edges::check(cancel)?;
        let end = (start + BLOCK).min(count);
        let mut lo = u64::MAX;
        let mut hi = 0;
        for row in start..end {
            let v = value(row);
            lo = lo.min(v);
            hi = hi.max(v);
        }
        let w = width(hi - lo);
        descriptors.push((lo, w, size));
        size = size
            .checked_add(((end - start) * w) as u64)
            .ok_or_else(|| anyhow::anyhow!("Node column overflow"))?;
    }
    out.write_all(&size.to_le_bytes())?;
    for &(base, width, offset) in &descriptors {
        out.write_all(&base.to_le_bytes())?;
        out.write_all(&offset.to_le_bytes())?;
        out.write_all(&[width as u8])?;
    }
    let mut block = [0u8; BLOCK * 8];
    for (index, &(base, width, _)) in descriptors.iter().enumerate() {
        if width == 0 {
            continue;
        }
        let start = index * BLOCK;
        let end = (start + BLOCK).min(count);
        for row in start..end {
            block[(row - start) * width..(row - start + 1) * width]
                .copy_from_slice(&(value(row) - base).to_le_bytes()[..width]);
        }
        out.write_all(&block[..(end - start) * width])?;
    }
    Ok(())
}
pub(crate) fn write(
    nodes: &NodeStore,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<(Receipt, Vec<Arc<str>>)> {
    let mut names = Vec::new();
    // Preserve first-occurrence dictionary order, including when root names
    // were replaced. Numeric slots avoid cloning/hashing a name per object.
    let mut slots = vec![u32::MAX; nodes.name_count()];
    for row in 0..nodes.len() {
        if row % 4096 == 0 {
            super::disk_edges::check(cancel)?;
        }
        let original = nodes.name_slot_at(row as u32) as usize;
        if slots[original] == u32::MAX {
            let slot = u32::try_from(names.len())?;
            names.push(nodes.dictionary_name(original as u32).clone());
            slots[original] = slot;
        }
    }
    let mut sorted = Vec::new();
    if !nodes.has_construction_lookup() {
        sorted.try_reserve_exact(nodes.len())?;
        sorted.extend(0..u32::try_from(nodes.len())?);
    }
    use rayon::prelude::*;
    sorted.par_sort_unstable_by_key(|&i| nodes.id_at(i));
    super::disk_edges::check(cancel)?;
    let mut out = CacheWriter::new(directory, "nodes.bin", cancel)?;
    out.write_all(MAGIC)?;
    out.write_all(&(nodes.len() as u64).to_le_bytes())?;
    for column in 0..COLUMNS {
        encode_column(
            &mut out,
            nodes.len(),
            |i| {
                if column == 5 {
                    return if nodes.has_construction_lookup() {
                        u64::from(nodes.lookup_order_at(i as u32))
                    } else {
                        u64::from(sorted[i])
                    };
                }
                let row = i as u32;
                match column {
                    0 => nodes.id_at(row),
                    1 => nodes.shallow_at(row),
                    2 => u64::from(nodes.class_at(row)),
                    3 => u64::from(slots[nodes.name_slot_at(row) as usize]),
                    4 => nodes.kind_at(row) as u64,
                    _ => unreachable!(),
                }
            },
            cancel,
        )?;
    }
    Ok((out.finish()?, names))
}
impl MappedNodes {
    fn value(&self, column: usize, row: usize) -> u64 {
        let c = self.columns[column];
        let at = c.descriptors + (row / BLOCK) * DESCRIPTOR;
        let base = word(&self.bytes[at..]);
        let offset = word(&self.bytes[at + 8..]) as usize;
        let width = self.bytes[at + 16] as usize;
        let start = c.payload + offset + (row % BLOCK) * width;
        // Fixed-width branches let the compiler use integer loads rather than
        // a variable-length memcpy on every binary-search comparison.
        base + match width {
            0 => 0,
            1 => u64::from(self.bytes[start]),
            2 => u64::from(u16::from_le_bytes(
                self.bytes[start..start + 2].try_into().unwrap(),
            )),
            4 => u64::from(u32::from_le_bytes(
                self.bytes[start..start + 4].try_into().unwrap(),
            )),
            8 => word(&self.bytes[start..]),
            _ => unreachable!("Validated node width"),
        }
    }
    pub fn len(&self) -> usize {
        self.count
    }
    pub(crate) fn id_order_index(&self, rank: u32) -> u32 {
        assert!((rank as usize) < self.count);
        self.value(5, rank as usize) as u32
    }
    pub fn id_at(&self, row: u32) -> u64 {
        self.value(0, row as usize)
    }
    pub fn shallow_at(&self, row: u32) -> u64 {
        self.value(1, row as usize)
    }
    pub fn class_at(&self, row: u32) -> u32 {
        self.value(2, row as usize) as u32
    }
    pub fn name_at(&self, row: u32) -> &Arc<str> {
        &self.names[self.name_slot_at(row) as usize]
    }
    pub fn name_slot_at(&self, row: u32) -> u32 {
        self.value(3, row as usize) as u32
    }
    pub fn name_count(&self) -> usize {
        self.names.len()
    }
    pub fn dictionary_name(&self, slot: u32) -> &Arc<str> {
        &self.names[slot as usize]
    }
    pub fn kind_at(&self, row: u32) -> NodeType {
        kind(self.value(4, row as usize)).unwrap()
    }
    #[cfg(test)]
    pub fn get(&self, row: u32) -> NodeRecord {
        let i = row as usize;
        NodeRecord {
            id: self.value(0, i),
            shallow_size: self.value(1, i),
            class_index: self.value(2, i) as u32,
            class_name: self.names[self.value(3, i) as usize].clone(),
            node_type: kind(self.value(4, i)).unwrap(),
        }
    }
    pub fn index_of(&self, id: u64) -> Option<u32> {
        let mut lo = 0;
        let mut hi = self.count;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let row = self.value(5, mid) as u32;
            match self.id_at(row).cmp(&id) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(row),
            }
        }
        None
    }
    pub fn validate_ids(&self, ids: impl Iterator<Item = u64>, cancel: &AtomicBool) -> Result<()> {
        let mut wanted = Vec::new();
        wanted.try_reserve_exact(ids.size_hint().1.unwrap_or(0))?;
        for (i, id) in ids.enumerate() {
            if i % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
            wanted.push(id);
        }
        use rayon::prelude::*;
        wanted.par_sort_unstable();
        wanted.dedup();
        super::disk_edges::check(cancel)?;
        // Merge against the validated frozen lookup order once. Repeating a
        // logarithmic lookup for every array made large reopen CPU-bound.
        let mut row = 0usize;
        for (i, id) in wanted.into_iter().enumerate() {
            if i % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
            while row < self.count && self.id_at(self.value(5, row) as u32) < id {
                row += 1;
                if row % 4096 == 0 {
                    super::disk_edges::check(cancel)?;
                }
            }
            ensure!(
                row < self.count && self.id_at(self.value(5, row) as u32) == id,
                "Invalid cached object metadata ID"
            );
        }
        Ok(())
    }
    pub fn map(
        directory: &Path,
        names: Vec<Arc<str>>,
        expected: usize,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let bytes: Column<u8> = Column::map(&directory.join("nodes.bin"))?;
        ensure!(
            bytes.len() >= 16
                && &bytes[..8] == MAGIC
                && word(&bytes[8..]) == expected as u64
                && expected > 0
                && expected < u32::MAX as usize,
            "Invalid compact node header"
        );
        let blocks = expected.div_ceil(BLOCK);
        let mut columns = [Packed::default(); COLUMNS];
        let mut cursor = 16usize;
        for c in &mut columns {
            ensure!(
                bytes.len().saturating_sub(cursor) >= 8,
                "Truncated node column"
            );
            let length = usize::try_from(word(&bytes[cursor..]))?;
            cursor += 8;
            let header = blocks
                .checked_mul(DESCRIPTOR)
                .ok_or_else(|| anyhow::anyhow!("Node descriptor overflow"))?;
            ensure!(
                header <= bytes.len() - cursor,
                "Invalid node descriptor length"
            );
            *c = Packed {
                descriptors: cursor,
                payload: cursor + header,
            };
            cursor += header;
            ensure!(length <= bytes.len() - cursor, "Truncated node values");
            let mut end = 0usize;
            for b in 0..blocks {
                if b % 4096 == 0 {
                    super::disk_edges::check(cancel)?;
                }
                let at = c.descriptors + b * DESCRIPTOR;
                let base = word(&bytes[at..]);
                let offset = usize::try_from(word(&bytes[at + 8..]))?;
                let w = bytes[at + 16] as usize;
                ensure!(
                    matches!(w, 0 | 1 | 2 | 4 | 8) && offset == end,
                    "Invalid node block"
                );
                end = end
                    .checked_add((expected - b * BLOCK).min(BLOCK) * w)
                    .ok_or_else(|| anyhow::anyhow!("Node block overflow"))?;
                ensure!(end <= length, "Invalid node block extent");
                // Most widths prove addition safety for a whole block. Only
                // a near-u64-limit base needs individual value checks.
                let max_delta = match w {
                    0 => 0,
                    8 => u64::MAX,
                    _ => (1u64 << (w * 8)) - 1,
                };
                if base.checked_add(max_delta).is_none() {
                    for row in 0..(expected - b * BLOCK).min(BLOCK) {
                        let start = cursor + offset + row * w;
                        let mut v = [0u8; 8];
                        v[..w].copy_from_slice(&bytes[start..start + w]);
                        ensure!(
                            base.checked_add(u64::from_le_bytes(v)).is_some(),
                            "Node value overflow"
                        );
                    }
                }
            }
            ensure!(end == length, "Unclaimed node bytes");
            cursor += length;
        }
        ensure!(cursor == bytes.len(), "Trailing node bytes");
        let nodes = Self {
            bytes,
            columns,
            names,
            count: expected,
        };
        let mut previous = None;
        for row in 0..expected {
            if row % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
            let k = kind(nodes.value(4, row))?;
            ensure!(
                nodes.value(2, row) <= u32::MAX as u64
                    && nodes.value(3, row) < nodes.names.len() as u64,
                "Invalid node metadata"
            );
            ensure!(
                (row == 0) == (k == NodeType::SuperRoot) && (row != 0 || nodes.value(0, row) == 0),
                "Invalid super root"
            );
            let index = nodes.value(5, row);
            ensure!(index < expected as u64, "Invalid node lookup index");
            let id = nodes.id_at(index as u32);
            ensure!(
                previous.is_none_or(|p| id > p),
                "Duplicate or unordered cached ID"
            );
            previous = Some(id);
        }
        Ok(nodes)
    }
}
fn kind(value: u64) -> Result<NodeType> {
    Ok(match value {
        0 => NodeType::SuperRoot,
        1 => NodeType::GcRoot,
        2 => NodeType::Class,
        3 => NodeType::Instance,
        4 => NodeType::ObjectArray,
        5 => NodeType::PrimitiveArray,
        _ => anyhow::bail!("Invalid node type"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> NodeStore {
        let mut n = NodeStore::new();
        n.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        for i in 1..800u64 {
            let id = if i == 799 { u64::MAX } else { (801 - i) * 16 };
            n.add_node(
                id,
                (i % 17) as u32,
                if i == 798 { u64::MAX } else { i % 2 * 8 + 16 },
                NodeType::Instance,
                Arc::from("Example"),
            );
        }
        n
    }
    #[test]
    fn numeric_dictionary_preserves_first_live_occurrence_after_root_upgrade() {
        let mut nodes = NodeStore::new();
        nodes.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        let root = nodes.add_node(7, 0, 0, NodeType::GcRoot, Arc::from("obsolete root name"));
        nodes.add_node(8, 0, 16, NodeType::Instance, Arc::from("Second"));
        nodes.define_node(7, 24, NodeType::Instance, Arc::from("First"));
        let dir = tempfile::tempdir().unwrap();
        let c = AtomicBool::new(false);
        let (_, names) = write(&nodes, dir.path(), &c).unwrap();
        assert_eq!(
            names.iter().map(|n| n.as_ref()).collect::<Vec<_>>(),
            vec!["SuperRoot", "First", "Second"]
        );
        let mapped = MappedNodes::map(dir.path(), names, nodes.len(), &c).unwrap();
        assert_eq!(mapped.name_at(root).as_ref(), "First");
        assert_eq!(mapped.shallow_at(root), 24);
    }
    #[test]
    fn mapped_columns_preserve_ids_sizes_names_types_and_unsorted_lookup() {
        let nodes = store();
        let dir = tempfile::tempdir().unwrap();
        let c = AtomicBool::new(false);
        let (receipt, names) = write(&nodes, dir.path(), &c).unwrap();
        assert!(receipt.bytes < (nodes.len() * 25) as u64);
        let mapped = MappedNodes::map(dir.path(), names, nodes.len(), &c).unwrap();
        for i in 0..nodes.len() {
            let old = nodes.get_by_index(i as u32);
            let new = mapped.get(i as u32);
            assert_eq!(
                (
                    new.id,
                    new.shallow_size,
                    new.class_index,
                    new.node_type,
                    &new.class_name
                ),
                (
                    old.id,
                    old.shallow_size,
                    old.class_index,
                    old.node_type,
                    old.class_name
                )
            );
            assert_eq!(mapped.index_of(old.id), Some(i as u32));
        }
        assert_eq!(mapped.index_of(12345), None);
        mapped
            .validate_ids([u64::MAX, 0, 48, 48].into_iter(), &c)
            .unwrap();
        mapped.validate_ids(std::iter::empty(), &c).unwrap();
        assert!(mapped.validate_ids([12345].into_iter(), &c).is_err());
        assert!(mapped
            .validate_ids([0].into_iter(), &AtomicBool::new(true))
            .is_err());
        let wrapped = NodeStore::mapped(mapped.clone());
        assert!(wrapped.nodes_are_mapped());
        assert_eq!(wrapped.clone().index_of(u64::MAX), Some(799));
    }
    #[test]
    fn truncated_trailing_invalid_width_offsets_and_overflows_fail_closed() {
        let n = store();
        let dir = tempfile::tempdir().unwrap();
        let c = AtomicBool::new(false);
        let (_, names) = write(&n, dir.path(), &c).unwrap();
        let target = dir.path().join("nodes.bin");
        let original = std::fs::read(&target).unwrap();
        let mut cases = vec![
            vec![],
            original[..15].to_vec(),
            original[..original.len() - 1].to_vec(),
        ];
        let mut trailing = original.clone();
        trailing.push(0);
        cases.push(trailing);
        for (at, v) in [(40, 3), (32, 1), (0, 0)] {
            let mut b = original.clone();
            b[at] = v;
            cases.push(b);
        }
        let mut overflow = original.clone();
        overflow[24..32].copy_from_slice(&u64::MAX.to_le_bytes());
        cases.push(overflow);
        for b in cases {
            std::fs::write(&target, b).unwrap();
            assert!(MappedNodes::map(dir.path(), names.clone(), n.len(), &c).is_err());
        }
    }
    #[test]
    fn all_kinds_constant_blocks_empty_names_and_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let c = AtomicBool::new(false);
        let mut n = NodeStore::new();
        for (id, k) in [
            NodeType::SuperRoot,
            NodeType::GcRoot,
            NodeType::Class,
            NodeType::Instance,
            NodeType::ObjectArray,
            NodeType::PrimitiveArray,
        ]
        .into_iter()
        .enumerate()
        {
            n.add_node(id as u64, 0, 0, k, Arc::from(""));
        }
        let (_, names) = write(&n, dir.path(), &c).unwrap();
        let m = MappedNodes::map(dir.path(), names.clone(), n.len(), &c).unwrap();
        for i in 0..n.len() {
            assert_eq!(m.get(i as u32).node_type, n.kind_at(i as u32));
        }
        assert!(MappedNodes::map(dir.path(), vec![], n.len(), &c).is_err());
        assert!(MappedNodes::map(dir.path(), names, n.len(), &AtomicBool::new(true)).is_err());
        assert!(write(
            &n,
            tempfile::tempdir().unwrap().path(),
            &AtomicBool::new(true)
        )
        .is_err());
    }
}
