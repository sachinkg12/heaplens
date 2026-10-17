//! Shared exact, mapped array counts and optional byte/char source ranges.
use super::{
    cache_writer::Receipt,
    node_store::NodeStore,
    packed_table::{Table, Writer},
    waste::ArrayContentRange,
};
use crate::waste::WasteRawData;
use anyhow::{ensure, Result};
use std::{path::Path, sync::atomic::AtomicBool};
const NAME: &str = "arrays.bin";
// id, has_count, count, has_range, offset, byte_length, shallow, is_char
#[derive(Debug, Clone)]
pub(crate) struct ArrayCatalog {
    table: Table<8>,
}
impl ArrayCatalog {
    pub fn write(
        raw: &WasteRawData,
        nodes: &NodeStore,
        directory: &Path,
        cancel: &AtomicBool,
    ) -> Result<Receipt> {
        let _timer = super::stage_timer::StageTimer::start("disk.array_catalog_write");
        ensure!(
            nodes.nodes_are_mapped(),
            "Array catalog requires frozen node order"
        );
        let contents = raw
            .lazy_contents
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Missing mapped array contents"))?;
        ensure!(raw.mapped_arrays.is_none(), "Array catalog already frozen");
        let mut out = Writer::<8>::new(directory, NAME, cancel)?;
        let mut counts = 0usize;
        let mut ranges = 0usize;
        for rank in 0..nodes.len() {
            if rank % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
            let index = nodes.mapped_id_order_index(rank as u32);
            // Only array nodes can carry these tables. Check counts below so an
            // unexpected ID can never be silently omitted by this filter.
            if !matches!(
                nodes.kind_at(index),
                super::node_store::NodeType::ObjectArray
                    | super::node_store::NodeType::PrimitiveArray
            ) {
                continue;
            }
            let id = nodes.id_at(index);
            let count = raw.array_element_counts.get(&id).copied();
            let range = contents.arrays.get(&id).copied();
            if count.is_none() && range.is_none() {
                continue;
            }
            let mut row = [
                id,
                u64::from(count.is_some()),
                u64::from(count.unwrap_or(0)),
                u64::from(range.is_some()),
                0,
                0,
                0,
                0,
            ];
            if let Some(v) = range {
                row[4] = v.offset as u64;
                row[5] = v.length as u64;
                row[6] = v.shallow_size;
                row[7] = u64::from(v.is_char);
                ranges += 1;
            }
            counts += usize::from(count.is_some());
            out.push(row)?;
        }
        ensure!(
            counts == raw.array_element_counts.len() && ranges == contents.arrays.len(),
            "Invalid array metadata ownership"
        );
        out.finish()
    }
    pub fn map(
        directory: &Path,
        nodes: usize,
        input_bytes: usize,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let _timer = super::stage_timer::StageTimer::start("index.array_catalog_map");
        let table = Table::<8>::map(directory, NAME, nodes, cancel)?;
        for i in 0..table.len() {
            if i % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
            let r = table.row(i);
            ensure!(
                r[1] <= 1
                    && r[2] <= u32::MAX as u64
                    && r[3] <= 1
                    && r[7] <= 1
                    && (r[1] != 0 || r[2] == 0)
                    && (r[1] != 0 || r[3] != 0),
                "Invalid array catalog flags"
            );
            if r[3] == 0 {
                ensure!(r[4..].iter().all(|v| *v == 0), "Unexpected array range");
            } else {
                ensure!(
                    r[4].checked_add(r[5])
                        .is_some_and(|v| v <= input_bytes as u64)
                        && (r[7] == 0 || r[5] % 2 == 0),
                    "Invalid mapped array range"
                );
            }
        }
        Ok(Self { table })
    }
    pub fn count(&self, id: u64) -> Option<u32> {
        let r = self.table.find(id)?;
        (r[1] == 1).then_some(r[2] as u32)
    }
    pub fn range(&self, id: u64) -> Option<ArrayContentRange> {
        let r = self.table.find(id)?;
        if r[3] == 0 {
            return None;
        }
        Some(ArrayContentRange {
            offset: r[4] as usize,
            length: r[5] as usize,
            shallow_size: r[6],
            is_char: r[7] == 1,
        })
    }
    pub fn len(&self) -> usize {
        self.table.len()
    }
    pub fn id_at(&self, index: usize) -> u64 {
        self.table.key_at(index)
    }
    pub fn row_at(&self, index: usize) -> [u64; 8] {
        self.table.row(index)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_counts_ranges_full_width_and_hostile_ranges() -> Result<()> {
        let d = tempfile::tempdir()?;
        let c = AtomicBool::new(false);
        let mut w = Writer::<8>::new(d.path(), NAME, &c)?;
        w.push([1, 1, 0, 0, 0, 0, 0, 0])?;
        w.push([u64::MAX, 1, 3, 1, 1 << 33, 6, 32, 1])?;
        w.finish()?;
        let m = ArrayCatalog::map(d.path(), 3, (1usize << 33) + 6, &c)?;
        assert_eq!(m.count(1), Some(0));
        assert_eq!(m.count(2), None);
        assert_eq!(m.count(u64::MAX), Some(3));
        let r = m.range(u64::MAX).unwrap();
        assert_eq!(
            (r.offset, r.length, r.shallow_size, r.is_char),
            (1usize << 33, 6, 32, true)
        );
        assert!(m.range(1).is_none());
        assert!(ArrayCatalog::map(d.path(), 3, 8, &c).is_err());
        Ok(())
    }
}
