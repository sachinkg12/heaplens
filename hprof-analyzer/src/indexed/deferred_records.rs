//! Compact source locations in memory, or sequential private spools for disk builds.
use super::{
    parse::{DeferredBytes, DeferredInstance},
    sorted_runs::{MappedRows, Row, Sorter},
};
use anyhow::{ensure, Result};
use std::{
    borrow::Cow,
    collections::HashMap,
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Location {
    node: u32,
    class: u32,
    offset: u64,
    length: u64,
}
impl Row for Location {
    const WIDTH: usize = 24;
    fn write(self, out: &mut impl Write) -> Result<()> {
        out.write_all(&self.node.to_le_bytes())?;
        out.write_all(&self.class.to_le_bytes())?;
        out.write_all(&self.offset.to_le_bytes())?;
        out.write_all(&self.length.to_le_bytes())?;
        Ok(())
    }
    fn decode(b: &[u8]) -> Self {
        Self {
            node: u32::from_le_bytes(b[..4].try_into().unwrap()),
            class: u32::from_le_bytes(b[4..8].try_into().unwrap()),
            offset: u64::from_le_bytes(b[8..16].try_into().unwrap()),
            length: u64::from_le_bytes(b[16..24].try_into().unwrap()),
        }
    }
}
enum Backing {
    Owned(Vec<DeferredInstance>),
    Compact(Vec<Location>),
    Writing {
        output: BufWriter<File>,
        owner: Arc<tempfile::TempDir>,
        count: usize,
    },
    Mapped(MappedRows<Location>),
}
pub struct DeferredRecords {
    backing: Backing,
    classes: Vec<u64>,
    slots: HashMap<u64, u32>,
}
impl From<Vec<DeferredInstance>> for DeferredRecords {
    fn from(records: Vec<DeferredInstance>) -> Self {
        Self {
            backing: Backing::Owned(records),
            classes: Vec::new(),
            slots: HashMap::new(),
        }
    }
}
impl DeferredRecords {
    pub(crate) fn new(count: usize, mapped: bool, directory: Option<&Path>) -> Result<Self> {
        let backing = if let Some(parent) = directory {
            ensure!(mapped, "Disk construction requires mapped source locations");
            let owner = Arc::new(
                tempfile::Builder::new()
                    .prefix("locations-")
                    .tempdir_in(parent)?,
            );
            let file = super::disk_edges::create(&owner.path().join("rows"))?;
            Backing::Writing {
                output: BufWriter::with_capacity(64 * 1024, file),
                owner,
                count: 0,
            }
        } else if mapped {
            let mut rows = Vec::new();
            rows.try_reserve_exact(count)?;
            Backing::Compact(rows)
        } else {
            let mut rows = Vec::new();
            rows.try_reserve_exact(count)?;
            Backing::Owned(rows)
        };
        Ok(Self {
            backing,
            classes: Vec::new(),
            slots: HashMap::new(),
        })
    }
    pub fn len(&self) -> usize {
        match &self.backing {
            Backing::Owned(v) => v.len(),
            Backing::Compact(v) => v.len(),
            Backing::Writing { count, .. } => *count,
            Backing::Mapped(v) => v.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn capacity(&self) -> usize {
        match &self.backing {
            Backing::Owned(v) => v.capacity(),
            Backing::Compact(v) => v.capacity(),
            _ => 0,
        }
    }
    pub(crate) fn push(&mut self, record: DeferredInstance) -> Result<()> {
        if let Backing::Owned(values) = &mut self.backing {
            values.push(record);
            return Ok(());
        }
        let DeferredBytes::Mapped { offset, length } = record.field_bytes else {
            anyhow::bail!("Mapped construction catalog cannot own source payloads");
        };
        let slot = if let Some(&slot) = self.slots.get(&record.class_obj_id) {
            slot
        } else {
            let slot = u32::try_from(self.classes.len())?;
            self.classes.push(record.class_obj_id);
            self.slots.insert(record.class_obj_id, slot);
            slot
        };
        let row = Location {
            node: record.node_idx,
            class: slot,
            offset: u64::try_from(offset)?,
            length: u64::try_from(length)?,
        };
        match &mut self.backing {
            Backing::Compact(rows) => rows.push(row),
            Backing::Writing { output, count, .. } => {
                row.write(output)?;
                *count = count
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("Catalog count overflow"))?;
            }
            _ => anyhow::bail!("Construction catalog already finalized"),
        }
        Ok(())
    }
    pub(crate) fn finish(&mut self) -> Result<()> {
        if let Backing::Writing {
            output,
            owner,
            count,
        } = &mut self.backing
        {
            output.flush()?;
            let mapped = MappedRows::open(&owner.path().join("rows"), owner.clone())?;
            ensure!(mapped.len() == *count, "Incomplete construction catalog");
            self.backing = Backing::Mapped(mapped);
        }
        Ok(())
    }
    fn record(&self, row: Location) -> DeferredInstance {
        DeferredInstance {
            node_idx: row.node,
            class_obj_id: self.classes[row.class as usize],
            field_bytes: DeferredBytes::Mapped {
                offset: row.offset as usize,
                length: row.length as usize,
            },
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = Cow<'_, DeferredInstance>> {
        (0..self.len()).map(|i| match &self.backing {
            Backing::Owned(rows) => Cow::Borrowed(&rows[i]),
            Backing::Compact(rows) => Cow::Owned(self.record(rows[i])),
            Backing::Mapped(rows) => Cow::Owned(self.record(rows.get(i))),
            Backing::Writing { .. } => panic!("Construction catalog not finalized"),
        })
    }
    /// Reuse exact, already-interned class slots instead of hashing each class
    /// twice again when materializing the on-demand body index.
    pub(crate) fn locations(&self) -> Option<(&[u64], impl Iterator<Item = (u32, u32, u64, u64)> + '_)> {
        if !matches!(&self.backing, Backing::Compact(_) | Backing::Mapped(_)) { return None; }
        Some((&self.classes, (0..self.len()).map(|i| {
            let row = match &self.backing {
                Backing::Compact(rows) => rows[i],
                Backing::Mapped(rows) => rows.get(i),
                _ => unreachable!("validated mapped catalog"),
            };
            (row.node, row.class, row.offset, row.length)
        })))
    }
    pub(crate) fn sort_by_node(
        &mut self,
        parent: &Path,
        bytes: usize,
        cancel: &AtomicBool,
    ) -> Result<()> {
        match &mut self.backing {
            Backing::Owned(rows) => rows.sort_unstable_by_key(|r| r.node_idx),
            Backing::Compact(rows) => rows.sort_unstable_by_key(|r| r.node),
            Backing::Mapped(rows) => {
                let mut sorter = Sorter::new(parent, bytes, false, cancel)?;
                for row in rows.iter() {
                    sorter.push(row)?;
                }
                let sorted = sorter.finish()?;
                self.backing = Backing::Mapped(sorted);
            }
            Backing::Writing { .. } => anyhow::bail!("Construction catalog not finalized"),
        }
        Ok(())
    }
    pub(crate) fn extract<F>(
        &self,
        extract: F,
        mut consume: impl FnMut(&[(u32, u32, u8)]) -> Result<()> + Send,
    ) -> Result<()>
    where
        F: Fn(&DeferredInstance, &mut dyn FnMut((u32, u32, u8)) -> Result<()>) -> Result<()> + Sync,
    {
        match &self.backing {
            Backing::Owned(rows) => super::bounded_edges::extract(rows, extract, consume),
            Backing::Compact(rows) => super::bounded_edges::extract(
                rows,
                |row, emit| extract(&self.record(*row), emit),
                consume,
            ),
            Backing::Mapped(_) => {
                for row in self.iter() {
                    extract(&row, &mut |edge| consume(std::slice::from_ref(&edge)))?;
                }
                Ok(())
            }
            Backing::Writing { .. } => anyhow::bail!("Construction catalog not finalized"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_and_spooled_locations_preserve_full_offsets_ids_and_sorted_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        for disk in [false, true] {
            let mut rows = DeferredRecords::new(3, true, disk.then_some(dir.path())).unwrap();
            for node in [9, 2, 7] {
                rows.push(DeferredInstance {
                    node_idx: node,
                    class_obj_id: u64::MAX - 12,
                    field_bytes: DeferredBytes::Mapped {
                        offset: u32::MAX as usize + node as usize,
                        length: u32::MAX as usize + 5,
                    },
                })
                .unwrap();
            }
            rows.finish().unwrap();
            rows.sort_by_node(dir.path(), 48, &cancel).unwrap();
            let values: Vec<_> = rows.iter().map(|r| { assert_eq!(r.class_obj_id, u64::MAX - 12);
                assert!(matches!(r.field_bytes, DeferredBytes::Mapped { length, .. } if length > u32::MAX as usize)); r.node_idx }).collect();
            assert_eq!(values, vec![2, 7, 9]);
        }
        assert_eq!(std::mem::size_of::<Location>(), 24);
    }
}
