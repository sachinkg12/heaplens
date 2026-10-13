//! Sorted instance-body locations permit local reads without rescanning records.
use super::{
    column::Column,
    parse::{DeferredBytes, DeferredInstance},
};
use anyhow::{ensure, Result};
use std::{io::Write, path::Path};
#[derive(Debug)]
pub struct ObjectBodies {
    values: Column<u64>,
}
impl ObjectBodies {
    pub(crate) fn memory(records: &[DeferredInstance]) -> Self {
        let mut values = Vec::with_capacity(records.len() * 4);
        for record in records {
            if let DeferredBytes::Mapped { offset, length } = record.field_bytes {
                values.extend([
                    record.node_idx as u64,
                    record.class_obj_id,
                    offset as u64,
                    length as u64,
                ]);
            }
        }
        // Input records are usually in node order, but roots may create nodes first.
        values
            .as_mut_slice()
            .as_chunks_mut::<4>()
            .0
            .sort_unstable_by_key(|row| row[0]);
        Self {
            values: values.into(),
        }
    }
    pub(crate) fn write_records(
        records: &mut [DeferredInstance],
        directory: &Path,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<super::cache_writer::Receipt> {
        records.sort_unstable_by_key(|record| record.node_idx);
        let mut writer =
            super::cache_writer::CacheWriter::new(directory, "instance.bodies", cancel)?;
        for record in records {
            if let DeferredBytes::Mapped { offset, length } = record.field_bytes {
                for value in [
                    record.node_idx as u64,
                    record.class_obj_id,
                    offset as u64,
                    length as u64,
                ] {
                    writer.write_all(&value.to_le_bytes())?;
                }
            } else {
                anyhow::bail!("Disk body records require mapped input");
            }
        }
        writer.finish()
    }
    pub(crate) fn map(directory: &Path, nodes: usize, input_bytes: usize) -> Result<Self> {
        let values = Column::<u64>::map(&directory.join("instance.bodies"))?;
        ensure!(values.len() % 4 == 0, "Invalid body index length");
        let mut previous = None;
        for row in values.chunks_exact(4) {
            ensure!(
                row[0] < nodes as u64 && previous.is_none_or(|id| id < row[0]),
                "Invalid body node index"
            );
            ensure!(
                row[2]
                    .checked_add(row[3])
                    .is_some_and(|end| end <= input_bytes as u64),
                "Invalid body range"
            );
            previous = Some(row[0]);
        }
        Ok(Self { values })
    }
    pub(crate) fn fields<'a>(&self, node: u32, input: &'a [u8]) -> Option<(u64, &'a [u8])> {
        let mut low = 0;
        let mut high = self.values.len() / 4;
        while low < high {
            let middle = (low + high) / 2;
            let row = &self.values[middle * 4..middle * 4 + 4];
            match row[0].cmp(&(node as u64)) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => {
                    let offset = usize::try_from(row[2]).ok()?;
                    let length = usize::try_from(row[3]).ok()?;
                    return Some((row[1], input.get(offset..offset.checked_add(length)?)?));
                }
            }
        }
        None
    }
}
