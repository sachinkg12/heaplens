//! Disk construction uses an exact sorted ID catalog and file-backed node rows.
//! No dynamic all-object hash table is built alongside the frozen lookup.
use super::{
    node_store::{NodeRecord, NodeType},
    sorted_runs::MappedRows,
};
use anyhow::{ensure, Result};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
const ROW: usize = 25;

fn initialize_rows(output: &mut impl Write, mut bytes: usize, cancel: &AtomicBool) -> Result<()> {
    let zero = [0u8; 64 * 1024];
    while bytes > 0 {
        super::disk_edges::check(cancel)?;
        let count = bytes.min(zero.len());
        output.write_all(&zero[..count])?;
        bytes -= count;
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct ConstructionNodes {
    rows: memmap2::MmapMut,
    row_start: usize,
    count: usize,
    ids: MappedRows<u64>,
    names: Vec<Arc<str>>,
    slots: HashMap<Arc<str>, u32>,
    identities: HashMap<(usize, usize), u32>,
    // Lookup ranges use the variable address bits, not an assumed ID ordering
    // in HPROF records or an assumption that all JVM addresses are compressed.
    shift: u32,
    boundaries: Vec<u32>,
    _owner: tempfile::TempDir,
}
impl ConstructionNodes {
    pub fn new(ids: MappedRows<u64>, directory: &Path, cancel: &AtomicBool) -> Result<Self> {
        ensure!(
            ids.len() > 0 && ids.len() < u32::MAX as usize && ids.get(0) == 0,
            "Invalid construction ID catalog"
        );
        let owner = tempfile::Builder::new()
            .prefix("node-rows-")
            .tempdir_in(directory)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(owner.path().join("rows"))?;
        let bytes = ids
            .len()
            .checked_mul(ROW + 4)
            .ok_or_else(|| anyhow::anyhow!("Construction row length overflow"))?;
        // A sparse set_len can succeed without reserving backing storage, then
        // fault during a mapped write. Surface initial allocation/IO failures as
        // normal errors before mapping; do not claim this prevents later disk loss.
        initialize_rows(&mut file, bytes, cancel)?;
        file.sync_data()?;
        // Zero is an unpopulated row marker. No writable pointers are persisted.
        let rows = unsafe { memmap2::MmapMut::map_mut(&file)? };
        let bits = 64 - ids.get(ids.len() - 1).leading_zeros();
        let shift = bits.saturating_sub(12);
        let buckets = usize::try_from(ids.get(ids.len() - 1) >> shift)? + 1;
        let mut boundaries = vec![0; buckets + 1];
        let mut position = 0usize;
        for (bucket, boundary) in boundaries.iter_mut().enumerate() {
            while position < ids.len() && (ids.get(position) >> shift) < bucket as u64 {
                if position % 4096 == 0 {
                    super::disk_edges::check(cancel)?;
                }
                position += 1;
            }
            *boundary = position as u32;
        }
        let row_start = ids.len() * 4;
        Ok(Self {
            rows,
            row_start,
            count: 0,
            ids,
            names: Vec::new(),
            slots: HashMap::new(),
            identities: HashMap::new(),
            shift,
            boundaries,
            _owner: owner,
        })
    }
    pub fn len(&self) -> usize {
        self.count
    }
    fn at(&self, index: u32) -> usize {
        self.row_start + index as usize * ROW
    }
    pub fn id_at(&self, index: u32) -> u64 {
        let at = self.at(index);
        u64::from_le_bytes(self.rows[at..at + 8].try_into().unwrap())
    }
    pub fn locate(&self, id: u64) -> Option<u32> {
        let bucket = usize::try_from(id >> self.shift).ok()?;
        let mut lo = *self.boundaries.get(bucket)? as usize;
        let mut hi = *self.boundaries.get(bucket + 1)? as usize;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match self.ids.get(mid).cmp(&id) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(mid as u32),
            }
        }
        None
    }
    pub fn lookup_order_at(&self, rank: u32) -> u32 {
        let at = rank as usize * 4;
        u32::from_le_bytes(self.rows[at..at + 4].try_into().unwrap())
            .checked_sub(1)
            .expect("Unpopulated construction lookup")
    }
    pub fn index_of(&self, id: u64) -> Option<u32> {
        let rank = self.locate(id)? as usize * 4;
        u32::from_le_bytes(self.rows[rank..rank + 4].try_into().unwrap()).checked_sub(1)
    }
    pub fn add(&mut self, node: &NodeRecord) -> u32 {
        if let Some(index) = self.index_of(node.id) {
            return index;
        }
        let rank = self
            .locate(node.id)
            .expect("Sizing catalog must include every parsed object");
        let index = u32::try_from(self.count).unwrap();
        let at = self.at(index);
        self.rows[at..at + 8].copy_from_slice(&node.id.to_le_bytes());
        let lookup = rank as usize * 4;
        self.rows[lookup..lookup + 4].copy_from_slice(&(index + 1).to_le_bytes());
        self.set(index, node);
        self.count += 1;
        index
    }
    pub fn shallow_at(&self, index: u32) -> u64 {
        let at = self.at(index) + 8;
        u64::from_le_bytes(self.rows[at..at + 8].try_into().unwrap())
    }
    pub fn class_at(&self, index: u32) -> u32 {
        let at = self.at(index) + 16;
        u32::from_le_bytes(self.rows[at..at + 4].try_into().unwrap())
    }
    pub fn name_at(&self, index: u32) -> &Arc<str> {
        let at = self.at(index) + 20;
        &self.names[u32::from_le_bytes(self.rows[at..at + 4].try_into().unwrap()) as usize]
    }
    pub fn kind_at(&self, index: u32) -> NodeType {
        match self.rows[self.at(index) + 24] {
            1 => NodeType::SuperRoot,
            2 => NodeType::GcRoot,
            3 => NodeType::Class,
            4 => NodeType::Instance,
            5 => NodeType::ObjectArray,
            6 => NodeType::PrimitiveArray,
            _ => panic!("Unpopulated construction node"),
        }
    }
    #[cfg(test)]
    pub fn get(&self, index: u32) -> NodeRecord {
        NodeRecord {
            id: self.id_at(index),
            shallow_size: self.shallow_at(index),
            class_index: self.class_at(index),
            node_type: self.kind_at(index),
            class_name: self.name_at(index).clone(),
        }
    }
    fn intern(&mut self, name: &Arc<str>) -> u32 {
        let identity = (name.as_ptr() as usize, name.len());
        if let Some(&slot) = self.identities.get(&identity) {
            return slot;
        }
        if let Some(&slot) = self.slots.get(name.as_ref()) {
            return slot;
        }
        let slot = u32::try_from(self.names.len()).expect("Class dictionary overflow");
        // Only retained canonical names enter the pointer memo. Temporary equal
        // Arc allocations cannot leave dangling identities that get reused.
        self.names.push(name.clone());
        self.slots.insert(name.clone(), slot);
        self.identities.insert(identity, slot);
        slot
    }
    pub fn set(&mut self, index: u32, node: &NodeRecord) {
        assert_eq!(self.id_at(index), node.id, "Node identity is immutable");
        let name = self.intern(&node.class_name);
        let at = self.at(index) + 8;
        self.rows[at..at + 8].copy_from_slice(&node.shallow_size.to_le_bytes());
        self.rows[at + 8..at + 12].copy_from_slice(&node.class_index.to_le_bytes());
        self.rows[at + 12..at + 16].copy_from_slice(&name.to_le_bytes());
        self.rows[at + 16] = node.node_type as u8 + 1;
    }
    pub fn validate_complete(&self) -> Result<()> {
        ensure!(
            self.count == self.ids.len(),
            "Incomplete construction catalog"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_lookup_handles_sparse_full_width_unknown_and_unpopulated_ids() {
        let root = tempfile::tempdir().unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut sorter =
            super::super::sorted_runs::Sorter::new(root.path(), 32, true, &cancel).unwrap();
        for id in [0, 5, 1 << 48, u64::MAX] {
            sorter.push(id).unwrap();
        }
        let mut nodes =
            ConstructionNodes::new(sorter.finish().unwrap(), root.path(), &cancel).unwrap();
        for (index, id) in [u64::MAX, 0, 1 << 48, 5].into_iter().enumerate() {
            let index = index as u32;
            assert_eq!(nodes.index_of(id), None);
            assert_eq!(
                nodes.add(&NodeRecord {
                    id,
                    class_index: 0,
                    shallow_size: 42,
                    node_type: NodeType::Instance,
                    class_name: Arc::from("Same")
                }),
                index
            );
            assert_eq!(nodes.index_of(id), Some(index));
            assert_eq!(nodes.get(index).shallow_size, 42);
        }
        for id in [1, 4, 6, (1 << 48) + 1, u64::MAX - 1] {
            assert_eq!(nodes.index_of(id), None);
        }
        nodes.validate_complete().unwrap();
        assert_eq!(nodes.names.len(), 1);
        assert_eq!(
            (0..4).map(|i| nodes.lookup_order_at(i)).collect::<Vec<_>>(),
            vec![1, 3, 2, 0]
        );
    }
    #[test]
    fn row_initialization_is_bounded_cancellable_and_propagates_storage_failure() {
        struct Full;
        impl Write for Full {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("simulated storage failure"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let cancel = AtomicBool::new(false);
        assert!(initialize_rows(&mut Full, 1_000_000, &cancel).is_err());
        assert!(initialize_rows(&mut Vec::new(), 1, &AtomicBool::new(true)).is_err());
        let mut bytes = Vec::new();
        initialize_rows(&mut bytes, 65_537, &cancel).unwrap();
        assert_eq!(bytes.len(), 65_537);
        assert!(bytes.iter().all(|&b| b == 0));
    }
}
