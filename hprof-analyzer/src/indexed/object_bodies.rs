//! Sorted instance-body locations permit local reads without rescanning records.
use super::{
    column::Column,
    parse::{DeferredBytes, DeferredInstance},
};
use anyhow::{ensure, Result};
#[cfg(test)]
use std::io::Write;
use std::{collections::HashMap, path::Path};
const MAGIC: [u8; 8] = *b"HLBODY04";
const HEADER_WORDS: usize = 6;
const ROW_WORDS: usize = 5;
#[derive(Debug)]
pub struct ObjectBodies {
    values: Column<u32>,
    rows_start: usize,
    packed: Option<super::packed_table::Table<4>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn packed_body_rows_preserve_full_width_ids_offsets_and_reject_invalid_extents() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let c = AtomicBool::new(false);
        let source = vec![
            record(5, u64::MAX, 1usize << 40, 17),
            record(1, 1u64 << 50, 0, 0),
        ];
        let mut records = super::super::deferred_records::DeferredRecords::from(source.clone());
        ObjectBodies::write_catalog(&mut records, dir.path(), 1024, &c)?;
        let map = ObjectBodies::map_cancellable(dir.path(), 6, (1usize << 40) + 17, &c)?;
        let table = map.packed.as_ref().unwrap();
        assert_eq!(table.row(0), [1, 1u64 << 50, 0, 0]);
        assert_eq!(table.row(1), [5, u64::MAX, 1u64 << 40, 17]);
        assert_eq!(map.fields(1, b""), Some((1u64 << 50, &b""[..])));
        assert!(map.fields(5, b"short").is_none());
        assert!(ObjectBodies::map_cancellable(dir.path(), 6, 100, &c).is_err());
        assert!(ObjectBodies::map_cancellable(dir.path(), 5, (1usize << 40) + 17, &c).is_err());
        c.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(ObjectBodies::map_cancellable(dir.path(), 6, (1usize << 40) + 17, &c).is_err());
        Ok(())
    }

    fn record(node_idx: u32, class_obj_id: u64, offset: usize, length: usize) -> DeferredInstance {
        DeferredInstance {
            node_idx,
            class_obj_id,
            field_bytes: DeferredBytes::Mapped { offset, length },
        }
    }
    fn encoded(records: &mut [DeferredInstance]) -> (tempfile::TempDir, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let receipt =
            ObjectBodies::write_records(records, dir.path(), &AtomicBool::new(false)).unwrap();
        let bytes = std::fs::read(dir.path().join("instance.bodies")).unwrap();
        assert_eq!(receipt.bytes, bytes.len() as u64);
        assert_eq!(receipt.digest, blake3::hash(&bytes).to_hex().to_string());
        (dir, bytes)
    }

    #[test]
    fn compact_memory_and_disk_fields_match_with_shared_full_width_class_ids() {
        let class = u64::MAX - 100;
        let mut records = vec![
            record(8, class, 4, 3),
            record(2, 0x100000002, 0, 0),
            record(5, class, 1, 2),
        ];
        let memory = ObjectBodies::memory(&records).unwrap();
        let (dir, bytes) = encoded(&mut records);
        assert_eq!(bytes.len(), 24 + 2 * 8 + 3 * 20);
        let mapped = ObjectBodies::map(dir.path(), 9, 7).unwrap();
        for node in 0..9 {
            assert_eq!(
                memory.fields(node, b"abcdefg"),
                mapped.fields(node, b"abcdefg")
            );
        }
        assert_eq!(mapped.fields(8, b"abcdefg"), Some((class, &b"efg"[..])));
        assert_eq!(mapped.fields(2, b"abcdefg"), Some((0x100000002, &b""[..])));
        assert_eq!(mapped.fields(8, b"short"), None);
    }

    #[test]
    fn reuse_class_slots_matches_owned_catalog_for_root_order_and_full_width_ids() {
        let records = vec![
            record(8, u64::MAX, 4, 3),
            record(2, 0x100000002, 0, 0),
            record(5, u64::MAX, 1, 2),
        ];
        let owned = ObjectBodies::memory(&records).unwrap();
        let mut compact =
            super::super::deferred_records::DeferredRecords::new(records.len(), true, None)
                .unwrap();
        for record in records {
            compact.push(record).unwrap();
        }
        let indexed = ObjectBodies::memory_catalog(&compact).unwrap();
        for node in 0..9 {
            assert_eq!(
                owned.fields(node, b"abcdefg"),
                indexed.fields(node, b"abcdefg")
            );
        }
        let mut invalid =
            super::super::deferred_records::DeferredRecords::new(1, true, None).unwrap();
        invalid
            .push(record(1, 2, 0, u32::MAX as usize + 1))
            .unwrap();
        assert!(ObjectBodies::memory_catalog(&invalid).is_err());
    }
    #[test]
    fn disk_interned_slots_preserve_fields_after_reordering_and_reject_long_lengths() {
        let cancel = AtomicBool::new(false);
        for order in [vec![8, 2, 5], vec![2, 5, 8]] {
            let dir = tempfile::tempdir().unwrap();
            let mut compact =
                super::super::deferred_records::DeferredRecords::new(3, true, Some(dir.path()))
                    .unwrap();
            for node in order {
                compact
                    .push(record(
                        node,
                        if node == 2 { 1 << 48 } else { u64::MAX },
                        node as usize,
                        1,
                    ))
                    .unwrap();
            }
            compact.finish().unwrap();
            ObjectBodies::write_catalog(&mut compact, dir.path(), 48, &cancel).unwrap();
            let mapped = ObjectBodies::map(dir.path(), 9, 9).unwrap();
            for node in [2, 5, 8] {
                assert_eq!(
                    mapped.fields(node, b"012345678"),
                    Some((
                        if node == 2 { 1 << 48 } else { u64::MAX },
                        &b"012345678"[node as usize..node as usize + 1]
                    ))
                );
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let mut invalid =
            super::super::deferred_records::DeferredRecords::new(1, true, Some(dir.path()))
                .unwrap();
        invalid
            .push(record(1, 2, 0, u32::MAX as usize + 1))
            .unwrap();
        invalid.finish().unwrap();
        assert!(ObjectBodies::write_catalog(&mut invalid, dir.path(), 48, &cancel).is_err());
    }

    #[test]
    fn body_offsets_above_four_gib_and_u32_lengths_are_not_truncated() {
        let offset = u32::MAX as usize + 100;
        let mut records = vec![record(1, u64::MAX, offset, 12)];
        let memory = ObjectBodies::memory(&records).unwrap();
        let (dir, _) = encoded(&mut records);
        let mapped = ObjectBodies::map(dir.path(), 2, offset + 12).unwrap();
        assert_eq!(
            ObjectBodies::u64(&memory.values[memory.rows_start + 2..]),
            offset as u64
        );
        assert_eq!(
            ObjectBodies::u64(&mapped.values[mapped.rows_start + 2..]),
            offset as u64
        );
        assert!(ObjectBodies::map(dir.path(), 2, offset + 11).is_err());
        let too_long = vec![record(1, 2, 0, u32::MAX as usize + 1)];
        assert!(ObjectBodies::memory(&too_long).is_err());
    }

    #[test]
    fn invalid_headers_counts_slots_nodes_ranges_and_trailing_data_are_rejected() {
        let mut records = vec![record(1, 42, 0, 3), record(2, 43, 3, 2)];
        let (dir, bytes) = encoded(&mut records);
        let target = dir.path().join("instance.bodies");
        let mut bad = Vec::new();
        bad.push(bytes[..bytes.len() - 4].to_vec());
        let mut trailing = bytes.clone();
        trailing.extend([0; 4]);
        bad.push(trailing);
        let mut magic = bytes.clone();
        magic[0] = 0;
        bad.push(magic);
        let mut counts = bytes.clone();
        counts[8..16].copy_from_slice(&u64::MAX.to_le_bytes());
        bad.push(counts);
        let mut classes = bytes.clone();
        classes[32..40].copy_from_slice(&42u64.to_le_bytes());
        bad.push(classes);
        for (at, value) in [(40, 3u32), (44, 2), (60, 1), (48, u32::MAX), (56, 100)] {
            let mut variant = bytes.clone();
            variant[at..at + 4].copy_from_slice(&value.to_le_bytes());
            bad.push(variant);
        }
        for variant in bad {
            std::fs::write(&target, variant).unwrap();
            assert!(ObjectBodies::map(dir.path(), 3, 5).is_err());
        }
        std::fs::write(&target, []).unwrap();
        assert!(ObjectBodies::map(dir.path(), 3, 5).is_err());
    }

    #[test]
    fn empty_owned_and_cancelled_records_are_handled_explicitly() {
        let (dir, bytes) = encoded(&mut []);
        assert_eq!(bytes.len(), 24);
        assert_eq!(
            ObjectBodies::map(dir.path(), 0, 0).unwrap().fields(0, b""),
            None
        );
        assert!(ObjectBodies::memory(&[DeferredInstance {
            node_idx: 1,
            class_obj_id: 2,
            field_bytes: DeferredBytes::Owned(vec![1])
        }])
        .is_err());
        let cancelled = tempfile::tempdir().unwrap();
        assert!(
            ObjectBodies::write_records(&mut [], cancelled.path(), &AtomicBool::new(true)).is_err()
        );
    }
}
impl ObjectBodies {
    fn classes(
        records: &super::deferred_records::DeferredRecords,
    ) -> Result<(Vec<u64>, HashMap<u64, u32>)> {
        let mut ids = Vec::new();
        let mut slots = HashMap::new();
        for record in records.iter() {
            ensure!(
                matches!(record.field_bytes, DeferredBytes::Mapped { .. }),
                "Body records require mapped input"
            );
            if let std::collections::hash_map::Entry::Vacant(entry) =
                slots.entry(record.class_obj_id)
            {
                entry.insert(u32::try_from(ids.len())?);
                ids.push(record.class_obj_id);
            }
        }
        Ok((ids, slots))
    }
    fn row(record: &DeferredInstance, slots: &HashMap<u64, u32>) -> Result<[u32; ROW_WORDS]> {
        if let DeferredBytes::Mapped { offset, length } = record.field_bytes {
            let offset = u64::try_from(offset)?;
            // HPROF encodes instance field-byte length as u32. Reject rather
            // than truncate values outside that format; keep offsets full u64.
            Ok([
                record.node_idx,
                slots[&record.class_obj_id],
                offset as u32,
                (offset >> 32) as u32,
                u32::try_from(length)?,
            ])
        } else {
            anyhow::bail!("Body records require mapped input");
        }
    }
    #[cfg(test)]
    fn memory(records: &[DeferredInstance]) -> Result<Self> {
        Self::memory_catalog(&records.to_vec().into())
    }
    pub(crate) fn memory_catalog(
        records: &super::deferred_records::DeferredRecords,
    ) -> Result<Self> {
        let compact = records.locations();
        let (ids, slots) = if let Some((ids, _)) = &compact {
            (ids.to_vec(), HashMap::new())
        } else {
            Self::classes(records)?
        };
        let rows_start = HEADER_WORDS + ids.len() * 2;
        let mut values = Vec::with_capacity(
            rows_start
                .checked_add(
                    records
                        .len()
                        .checked_mul(ROW_WORDS)
                        .ok_or_else(|| anyhow::anyhow!("Body index too large"))?,
                )
                .ok_or_else(|| anyhow::anyhow!("Body index too large"))?,
        );
        values.extend([
            u32::from_le_bytes(MAGIC[..4].try_into()?),
            u32::from_le_bytes(MAGIC[4..].try_into()?),
            ids.len() as u32,
            0,
            records.len() as u32,
            (records.len() as u64 >> 32) as u32,
        ]);
        for id in ids {
            values.extend([id as u32, (id >> 32) as u32]);
        }
        if let Some((_, rows)) = compact {
            for (node, class, offset, length) in rows {
                values.extend([
                    node,
                    class,
                    offset as u32,
                    (offset >> 32) as u32,
                    u32::try_from(length)?,
                ]);
            }
        } else {
            for record in records.iter() {
                values.extend(Self::row(&record, &slots)?);
            }
        }
        // Input records are usually in node order, but roots may create nodes first.
        values[rows_start..]
            .as_chunks_mut::<ROW_WORDS>()
            .0
            .sort_unstable_by_key(|row| row[0]);
        Ok(Self {
            values: values.into(),
            rows_start,
            packed: None,
        })
    }
    #[cfg(test)]
    fn write_records(
        records: &mut [DeferredInstance],
        directory: &Path,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<super::cache_writer::Receipt> {
        Self::write_legacy_catalog(&mut records.to_vec().into(), directory, 1024 * 1024, cancel)
    }
    pub(crate) fn write_catalog(
        records: &mut super::deferred_records::DeferredRecords,
        directory: &Path,
        sort_bytes: usize,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<super::cache_writer::Receipt> {
        let timer = super::stage_timer::StageTimer::start("disk.body_catalog_sort");
        records.sort_by_node(directory, sort_bytes, cancel)?;
        drop(timer);
        let _timer = super::stage_timer::StageTimer::start("disk.body_catalog_write");
        let mut writer =
            super::packed_table::Writer::<4>::new(directory, "instance.bodies", cancel)?;
        if let Some((ids, rows)) = records.locations() {
            for (node, slot, offset, length) in rows {
                ensure!(length <= u32::MAX as u64, "Body length overflow");
                let class = *ids
                    .get(slot as usize)
                    .ok_or_else(|| anyhow::anyhow!("Invalid body class slot"))?;
                writer.push([u64::from(node), class, offset, length as u64])?;
            }
        } else {
            for record in records.iter() {
                let DeferredBytes::Mapped { offset, length } = record.field_bytes else {
                    anyhow::bail!("Body records require mapped input");
                };
                ensure!(length <= u32::MAX as usize, "Body length overflow");
                writer.push([
                    u64::from(record.node_idx),
                    record.class_obj_id,
                    offset as u64,
                    length as u64,
                ])?;
            }
        }
        writer.finish()
    }
    #[cfg(test)]
    fn write_legacy_catalog(
        records: &mut super::deferred_records::DeferredRecords,
        directory: &Path,
        sort_bytes: usize,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<super::cache_writer::Receipt> {
        let timer = super::stage_timer::StageTimer::start("disk.body_catalog_sort");
        records.sort_by_node(directory, sort_bytes, cancel)?;
        drop(timer);
        let _timer = super::stage_timer::StageTimer::start("disk.body_catalog_write");
        let compact = records.locations();
        let (ids, slots) = if let Some((ids, _)) = &compact {
            (ids.to_vec(), HashMap::new())
        } else {
            Self::classes(records)?
        };
        let mut writer =
            super::cache_writer::CacheWriter::new(directory, "instance.bodies", cancel)?;
        writer.write_all(&MAGIC)?;
        writer.write_all(&(ids.len() as u64).to_le_bytes())?;
        writer.write_all(&(records.len() as u64).to_le_bytes())?;
        for id in ids {
            writer.write_all(&id.to_le_bytes())?;
        }
        if let Some((_, rows)) = compact {
            for (node, class, offset, length) in rows {
                let values = [
                    node,
                    class,
                    offset as u32,
                    (offset >> 32) as u32,
                    u32::try_from(length)?,
                ];
                let mut bytes = [0u8; ROW_WORDS * 4];
                for (word, value) in bytes.chunks_exact_mut(4).zip(values) {
                    word.copy_from_slice(&value.to_le_bytes());
                }
                writer.write_all(&bytes)?;
            }
        } else {
            for record in records.iter() {
                let mut bytes = [0u8; ROW_WORDS * 4];
                for (word, value) in bytes.chunks_exact_mut(4).zip(Self::row(&record, &slots)?) {
                    word.copy_from_slice(&value.to_le_bytes());
                }
                writer.write_all(&bytes)?;
            }
        }
        writer.finish()
    }
    #[cfg(test)]
    pub(crate) fn map(directory: &Path, nodes: usize, input_bytes: usize) -> Result<Self> {
        Self::map_cancellable(
            directory,
            nodes,
            input_bytes,
            &std::sync::atomic::AtomicBool::new(false),
        )
    }
    pub(crate) fn map_cancellable(
        directory: &Path,
        nodes: usize,
        input_bytes: usize,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<Self> {
        let _timer = super::stage_timer::StageTimer::start("index.body_catalog_map");
        use std::io::Read;
        super::disk_edges::check(cancel)?;
        let mut file = std::fs::File::open(directory.join("instance.bodies"))?;
        let mut magic = [0; 8];
        file.read_exact(&mut magic)?;
        if &magic != super::packed_table::MAGIC {
            ensure!(magic == MAGIC, "Invalid body index header");
            return Self::map_legacy(directory, nodes, input_bytes);
        }
        let table =
            super::packed_table::Table::<4>::map(directory, "instance.bodies", nodes, cancel)?;
        for i in 0..table.len() {
            if i % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
            let row = table.row(i);
            ensure!(
                row[0] < nodes as u64
                    && row[3] <= u32::MAX as u64
                    && row[2]
                        .checked_add(row[3])
                        .is_some_and(|end| end <= input_bytes as u64),
                "Invalid packed body range"
            );
        }
        Ok(Self {
            values: Vec::<u32>::new().into(),
            rows_start: 0,
            packed: Some(table),
        })
    }
    fn map_legacy(directory: &Path, nodes: usize, input_bytes: usize) -> Result<Self> {
        let values = Column::<u32>::map(&directory.join("instance.bodies"))?;
        ensure!(
            values.len() >= HEADER_WORDS
                && values[0].to_le_bytes() == MAGIC[..4]
                && values[1].to_le_bytes() == MAGIC[4..],
            "Invalid body index header"
        );
        let classes = Self::u64(&values[2..4]);
        let rows = Self::u64(&values[4..6]);
        ensure!(
            classes <= u32::MAX as u64 && rows <= nodes as u64 && classes <= rows,
            "Invalid body index counts"
        );
        let rows_start = HEADER_WORDS
            .checked_add(
                usize::try_from(classes)?
                    .checked_mul(2)
                    .ok_or_else(|| anyhow::anyhow!("Invalid class count"))?,
            )
            .ok_or_else(|| anyhow::anyhow!("Invalid class count"))?;
        let expected = rows_start
            .checked_add(
                usize::try_from(rows)?
                    .checked_mul(ROW_WORDS)
                    .ok_or_else(|| anyhow::anyhow!("Invalid body count"))?,
            )
            .ok_or_else(|| anyhow::anyhow!("Invalid body count"))?;
        ensure!(values.len() == expected, "Invalid body index length");
        let mut unique = std::collections::HashSet::new();
        for words in values[HEADER_WORDS..rows_start].chunks_exact(2) {
            ensure!(unique.insert(Self::u64(words)), "Duplicate body class ID");
        }
        let mut previous = None;
        for row in values[rows_start..].chunks_exact(ROW_WORDS) {
            ensure!(
                (row[0] as usize) < nodes
                    && previous.is_none_or(|id| id < row[0])
                    && (row[1] as u64) < classes,
                "Invalid body node index"
            );
            ensure!(
                Self::u64(&row[2..4])
                    .checked_add(row[4] as u64)
                    .is_some_and(|end| end <= input_bytes as u64),
                "Invalid body range"
            );
            previous = Some(row[0]);
        }
        Ok(Self {
            values,
            rows_start,
            packed: None,
        })
    }
    fn u64(words: &[u32]) -> u64 {
        words[0] as u64 | ((words[1] as u64) << 32)
    }
    pub(crate) fn fields<'a>(&self, node: u32, input: &'a [u8]) -> Option<(u64, &'a [u8])> {
        let (class,offset,length)=self.location(node)?;
        Some((class,input.get(offset..offset.checked_add(length)?)?))
    }
    /// Catalog lookup only: no HPROF reads, field decoding or fallback scan.
    pub(crate) fn location(&self, node: u32) -> Option<(u64, usize, usize)> {
        if let Some(table) = &self.packed {
            let row = table.find(u64::from(node))?;
            let offset = usize::try_from(row[2]).ok()?;
            let length = usize::try_from(row[3]).ok()?;
            return Some((row[1], offset, length));
        }
        let mut low = 0;
        let mut high = (self.values.len() - self.rows_start) / ROW_WORDS;
        while low < high {
            let middle = (low + high) / 2;
            let start = self.rows_start + middle * ROW_WORDS;
            let row = &self.values[start..start + ROW_WORDS];
            match row[0].cmp(&node) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => {
                    let offset = usize::try_from(Self::u64(&row[2..4])).ok()?;
                    let length = usize::try_from(row[4]).ok()?;
                    let class = HEADER_WORDS + row[1] as usize * 2;
                    return Some((Self::u64(&self.values[class..class + 2]), offset, length));
                }
            }
        }
        None
    }
}
