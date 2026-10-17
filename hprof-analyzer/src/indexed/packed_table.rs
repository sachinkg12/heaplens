//! Bounded sequential row blocks with directly mapped frame-of-reference fields.
//! Traversal columns remain unchanged. No decoded object-sized vector or cache.
use super::{
    cache_writer::{CacheWriter, Receipt},
    column::Column,
};
use anyhow::{ensure, Result};
use std::{
    fs::File,
    io::{BufReader, BufWriter, Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::AtomicBool,
};
pub(crate) const MAGIC: &[u8; 8] = b"HLTABLE1";
const END: &[u8; 8] = b"HLTABEND";
const BLOCK: usize = 256;
const HEADER: usize = 16;
const FOOTER: usize = 24;
const ENTRY: usize = 16;
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
fn delta(bytes: &[u8], width: usize) -> u64 {
    match width {
        0 => 0,
        1 => bytes[0] as u64,
        2 => u16::from_le_bytes(bytes[..2].try_into().unwrap()) as u64,
        4 => u32::from_le_bytes(bytes[..4].try_into().unwrap()) as u64,
        8 => word(bytes),
        _ => unreachable!("validated width"),
    }
}
pub(crate) struct Writer<'a, const N: usize> {
    out: CacheWriter<'a>,
    directory: BufWriter<File>,
    block: Vec<[u64; N]>,
    count: usize,
    position: u64,
    previous: Option<u64>,
    cancel: &'a AtomicBool,
}
impl<'a, const N: usize> Writer<'a, N> {
    pub fn new(directory: &Path, name: &str, cancel: &'a AtomicBool) -> Result<Self> {
        ensure!(N > 0 && N <= 16, "Invalid packed table width");
        let mut out = CacheWriter::new(directory, name, cancel)?;
        out.write_all(MAGIC)?;
        out.write_all(&(N as u32).to_le_bytes())?;
        out.write_all(&(BLOCK as u32).to_le_bytes())?;
        Ok(Self {
            out,
            directory: BufWriter::with_capacity(16384, tempfile::tempfile_in(directory)?),
            block: Vec::with_capacity(BLOCK),
            count: 0,
            position: HEADER as u64,
            previous: None,
            cancel,
        })
    }
    pub fn push(&mut self, row: [u64; N]) -> Result<()> {
        super::disk_edges::check(self.cancel)?;
        ensure!(
            self.count < u32::MAX as usize && self.previous.is_none_or(|v| row[0] > v),
            "Duplicate or unordered packed table key"
        );
        self.previous = Some(row[0]);
        self.count += 1;
        self.block.push(row);
        if self.block.len() == BLOCK {
            self.flush_block()?;
        }
        Ok(())
    }
    fn flush_block(&mut self) -> Result<()> {
        if self.block.is_empty() {
            return Ok(());
        }
        super::disk_edges::check(self.cancel)?;
        self.directory.write_all(&self.block[0][0].to_le_bytes())?;
        self.directory.write_all(&self.position.to_le_bytes())?;
        // The scratch bound is N * (9 + BLOCK * 8), independent of row count.
        let mut encoded = Vec::with_capacity(N * (9 + BLOCK * 8));
        for column in 0..N {
            let base = self.block.iter().map(|r| r[column]).min().unwrap();
            let max = self.block.iter().map(|r| r[column]).max().unwrap();
            let w = width(max - base);
            encoded.extend_from_slice(&base.to_le_bytes());
            encoded.push(w as u8);
            for row in &self.block {
                encoded.extend_from_slice(&(row[column] - base).to_le_bytes()[..w]);
            }
        }
        self.out.write_all(&encoded)?;
        self.position = self
            .position
            .checked_add(encoded.len() as u64)
            .ok_or_else(|| anyhow::anyhow!("Packed table length overflow"))?;
        self.block.clear();
        Ok(())
    }
    pub fn finish(mut self) -> Result<Receipt> {
        self.flush_block()?;
        self.directory.flush()?;
        self.directory.get_mut().seek(SeekFrom::Start(0))?;
        let mut directory = BufReader::with_capacity(
            16384,
            self.directory.into_inner().map_err(|e| e.into_error())?,
        );
        let mut buffer = [0u8; 16384];
        loop {
            use std::io::Read;
            super::disk_edges::check(self.cancel)?;
            let n = directory.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            self.out.write_all(&buffer[..n])?;
        }
        self.out.write_all(&self.position.to_le_bytes())?;
        self.out.write_all(&(self.count as u64).to_le_bytes())?;
        self.out.write_all(END)?;
        self.out.finish()
    }
}
#[derive(Debug, Clone)]
pub(crate) struct Table<const N: usize> {
    bytes: Column<u8>,
    count: usize,
    directory: usize,
}
impl<const N: usize> Table<N> {
    pub fn map(directory: &Path, name: &str, max_rows: usize, cancel: &AtomicBool) -> Result<Self> {
        super::disk_edges::check(cancel)?;
        let bytes: Column<u8> = Column::map(&directory.join(name))?;
        ensure!(
            N > 0 && N <= 16 && bytes.len() >= HEADER + FOOTER,
            "Truncated packed table"
        );
        ensure!(
            &bytes[..8] == MAGIC
                && u32::from_le_bytes(bytes[8..12].try_into()?) as usize == N
                && u32::from_le_bytes(bytes[12..16].try_into()?) as usize == BLOCK
                && &bytes[bytes.len() - 8..] == END,
            "Invalid packed table header"
        );
        let footer = bytes.len() - FOOTER;
        let start = usize::try_from(word(&bytes[footer..]))?;
        let count = usize::try_from(word(&bytes[footer + 8..]))?;
        ensure!(
            count <= max_rows && count < u32::MAX as usize && start >= HEADER && start <= footer,
            "Invalid packed table dimensions"
        );
        let blocks = count.div_ceil(BLOCK);
        ensure!(
            blocks.checked_mul(ENTRY) == Some(footer - start),
            "Invalid packed table directory"
        );
        let result = Self {
            bytes,
            count,
            directory: start,
        };
        let mut end = HEADER;
        let mut previous = None;
        for block in 0..blocks {
            super::disk_edges::check(cancel)?;
            let entry = start + block * ENTRY;
            let key = word(&result.bytes[entry..]);
            let offset = usize::try_from(word(&result.bytes[entry + 8..]))?;
            ensure!(offset == end, "Invalid packed block offset");
            let rows = (count - block * BLOCK).min(BLOCK);
            for column in 0..N {
                ensure!(
                    end <= start && start - end >= 9,
                    "Truncated packed block header"
                );
                let base = word(&result.bytes[end..]);
                let w = result.bytes[end + 8] as usize;
                end += 9;
                ensure!(
                    matches!(w, 0 | 1 | 2 | 4 | 8) && rows * w <= start - end,
                    "Invalid packed block extent"
                );
                let max = match w {
                    0 => 0,
                    8 => u64::MAX,
                    _ => (1u64 << (8 * w)) - 1,
                };
                for row in 0..rows {
                    if column != 0 && base.checked_add(max).is_some() {
                        break;
                    }
                    let value = base
                        .checked_add(delta(&result.bytes[end + row * w..], w))
                        .ok_or_else(|| anyhow::anyhow!("Packed value overflow"))?;
                    if column == 0 {
                        ensure!(
                            previous.is_none_or(|p| value > p),
                            "Duplicate or unordered packed key"
                        );
                        if row == 0 {
                            ensure!(value == key, "Invalid packed directory key");
                        }
                        previous = Some(value);
                    }
                }
                end += rows * w;
            }
        }
        ensure!(end == start, "Unclaimed packed table bytes");
        Ok(result)
    }
    pub fn len(&self) -> usize {
        self.count
    }
    pub fn row(&self, index: usize) -> [u64; N] {
        assert!(index < self.count);
        let block = index / BLOCK;
        let entry = self.directory + block * ENTRY;
        let mut at = word(&self.bytes[entry + 8..]) as usize;
        let rows = (self.count - block * BLOCK).min(BLOCK);
        std::array::from_fn(|_| {
            let base = word(&self.bytes[at..]);
            let w = self.bytes[at + 8] as usize;
            let value = base + delta(&self.bytes[at + 9 + (index % BLOCK) * w..], w);
            at += 9 + rows * w;
            value
        })
    }
    pub fn key_at(&self, index: usize) -> u64 {
        assert!(index < self.count);
        let entry = self.directory + (index / BLOCK) * ENTRY;
        let at = word(&self.bytes[entry + 8..]) as usize;
        word(&self.bytes[at..])
            + delta(
                &self.bytes[at + 9 + (index % BLOCK) * self.bytes[at + 8] as usize..],
                self.bytes[at + 8] as usize,
            )
    }
    pub fn find(&self, key: u64) -> Option<[u64; N]> {
        let mut low = 0;
        let mut high = self.count;
        while low < high {
            let middle = low + (high - low) / 2;
            match self.key_at(middle).cmp(&key) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return Some(self.row(middle)),
            }
        }
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_blocks_and_mutations_never_escape_validated_bounds() -> Result<()> {
        let d = tempfile::tempdir()?;
        let c = AtomicBool::new(false);
        let mut w = Writer::<4>::new(d.path(), "table", &c)?;
        let mut seed = 19u64;
        let mut expected = Vec::new();
        for i in 0..777u64 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let row = [i * 16, seed, (i % 3) << 40, u64::MAX - i % 7];
            expected.push(row);
            w.push(row)?;
        }
        w.finish()?;
        let table = Table::<4>::map(d.path(), "table", 777, &c)?;
        for (i, row) in expected.iter().enumerate() {
            assert_eq!(table.row(i), *row);
            assert_eq!(table.find(row[0]), Some(*row));
            assert_eq!(table.find(row[0] + 1), None);
        }
        drop(table);
        let p = d.path().join("table");
        let original = std::fs::read(&p)?;
        for i in (0..original.len()).step_by(37) {
            let mut changed = original.clone();
            changed[i] ^= 0xff;
            std::fs::write(&p, changed)?;
            let result = std::panic::catch_unwind(|| {
                if let Ok(table) = Table::<4>::map(d.path(), "table", 777, &c) {
                    for i in 0..table.len() {
                        let row = table.row(i);
                        assert_eq!(table.find(row[0]), Some(row));
                    }
                }
            });
            assert!(result.is_ok(), "mutation at {i} escaped validation");
        }
        Ok(())
    }
    #[test]
    fn exact_empty_partial_blocks_and_full_width_values() -> Result<()> {
        for count in [0, 1, 255, 256, 257, 2000] {
            let d = tempfile::tempdir()?;
            let c = AtomicBool::new(false);
            let mut w = Writer::<4>::new(d.path(), "table", &c)?;
            let rows: Vec<_> = (0..count)
                .map(|i| [i as u64 * 8, u64::MAX - i as u64, 1 << 48, (i % 33) as u64])
                .collect();
            for &r in &rows {
                w.push(r)?;
            }
            let receipt = w.finish()?;
            let m = Table::<4>::map(d.path(), "table", count, &c)?;
            assert_eq!(m.len(), count);
            for (i, r) in rows.iter().enumerate() {
                assert_eq!(&m.row(i), r);
                assert_eq!(m.find(r[0]), Some(*r));
            }
            assert_eq!(m.find(3), None);
            assert_eq!(
                receipt.digest,
                blake3::hash(&std::fs::read(d.path().join("table"))?)
                    .to_hex()
                    .to_string()
            );
        }
        Ok(())
    }
    #[test]
    fn invalid_keys_truncation_trailing_dimensions_and_cancel() -> Result<()> {
        let d = tempfile::tempdir()?;
        let c = AtomicBool::new(false);
        let mut w = Writer::<2>::new(d.path(), "table", &c)?;
        w.push([1, u64::MAX])?;
        assert!(w.push([1, 0]).is_err());
        w.push([2, 0])?;
        w.finish()?;
        let p = d.path().join("table");
        let original = std::fs::read(&p)?;
        for n in 0..original.len() {
            std::fs::write(&p, &original[..n])?;
            assert!(Table::<2>::map(d.path(), "table", 2, &c).is_err());
        }
        let mut cases = vec![];
        let mut b = original.clone();
        b.push(0);
        cases.push(b);
        for at in [0, 8, 12, 16 + 8] {
            let mut b = original.clone();
            b[at] = 3;
            cases.push(b);
        }
        let mut b = original.clone();
        b[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        cases.push(b);
        for b in cases {
            std::fs::write(&p, b)?;
            assert!(Table::<2>::map(d.path(), "table", 2, &c).is_err());
        }
        std::fs::write(&p, &original)?;
        assert!(Table::<2>::map(d.path(), "table", 1, &c).is_err());
        c.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(Table::<2>::map(d.path(), "table", 2, &c).is_err());
        assert!(Writer::<2>::new(d.path(), "cancel", &c).is_err());
        Ok(())
    }
}
