//! Bounded sorted runs, bounded fan-in merging and sequential CSR publication.
//! The buffer limit bounds edge sorting, not total process RSS or dominators.
use super::edge_store::EdgeStore;
use anyhow::{ensure, Result};
use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
type Edge = (u32, u32, u8);
use super::run_budget::FAN_IN;

pub(crate) fn create(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
pub(crate) fn check(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "Analysis cancelled");
    Ok(())
}
fn write_edge(out: &mut impl Write, edge: Edge) -> Result<()> {
    let mut bytes = [0; 9];
    bytes[..4].copy_from_slice(&edge.0.to_le_bytes());
    bytes[4..8].copy_from_slice(&edge.1.to_le_bytes());
    bytes[8] = edge.2;
    out.write_all(&bytes)?;
    Ok(())
}
fn read_edge(input: &mut impl BufRead) -> Result<Option<Edge>> {
    let available = input.fill_buf()?;
    if available.is_empty() {
        return Ok(None);
    }
    let mut bytes = [0; 9];
    if available.len() >= bytes.len() {
        bytes.copy_from_slice(&available[..9]);
        input.consume(9);
    } else {
        input.read_exact(&mut bytes)?;
    }
    Ok(Some((
        u32::from_le_bytes(bytes[..4].try_into()?),
        u32::from_le_bytes(bytes[4..8].try_into()?),
        bytes[8],
    )))
}

struct Sorter<'a> {
    dir: &'a Path,
    prefix: &'static str,
    buffer: Vec<Edge>,
    limit: usize,
    io_buffer: usize,
    levels: Vec<Vec<PathBuf>>,
    next: usize,
    cancel: &'a AtomicBool,
}
impl<'a> Sorter<'a> {
    fn new(
        dir: &'a Path,
        prefix: &'static str,
        bytes: usize,
        cancel: &'a AtomicBool,
    ) -> Result<Self> {
        let (rows_bytes, io_buffer) = super::run_budget::split(bytes, 8192);
        let limit = rows_bytes / std::mem::size_of::<Edge>();
        ensure!(limit > 0, "Edge buffer too small");
        Ok(Self {
            dir,
            prefix,
            buffer: Vec::with_capacity(limit),
            limit,
            io_buffer,
            levels: Vec::new(),
            next: 0,
            cancel,
        })
    }
    fn path(&mut self) -> PathBuf {
        let path = self.dir.join(format!("{}-{}.run", self.prefix, self.next));
        self.next += 1;
        path
    }
    fn add(&mut self, edge: Edge) -> Result<()> {
        if self.buffer.len() % 4096 == 0 {
            check(self.cancel)?;
        }
        self.buffer.push(edge);
        if self.buffer.len() == self.limit {
            self.flush()?;
        }
        Ok(())
    }
    fn flush(&mut self) -> Result<()> {
        check(self.cancel)?;
        if self.buffer.is_empty() {
            return Ok(());
        }
        self.buffer.sort_unstable();
        self.buffer.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1);
        let path = self.path();
        let mut writer = BufWriter::with_capacity(self.io_buffer, create(&path)?);
        for &edge in &self.buffer {
            write_edge(&mut writer, edge)?;
        }
        writer.flush()?;
        self.buffer.clear();
        self.promote(path, 0)?;
        Ok(())
    }
    fn merged(&mut self, inputs: Vec<PathBuf>) -> Result<PathBuf> {
        let output = self.path();
        merge(&inputs, &output, self.io_buffer, self.cancel)?;
        for input in inputs {
            std::fs::remove_file(input)?;
        }
        Ok(output)
    }
    fn promote(&mut self, path: PathBuf, level: usize) -> Result<()> {
        if self.levels.len() <= level {
            self.levels.push(Vec::new());
        }
        self.levels[level].push(path);
        if self.levels[level].len() == FAN_IN {
            let inputs = std::mem::take(&mut self.levels[level]);
            let output = self.merged(inputs)?;
            self.promote(output, level + 1)?;
        }
        Ok(())
    }
    fn finish(mut self) -> Result<PathBuf> {
        self.flush()?;
        drop(std::mem::take(&mut self.buffer));
        let mut runs: Vec<_> = std::mem::take(&mut self.levels)
            .into_iter()
            .flatten()
            .collect();
        if runs.is_empty() {
            let path = self.path();
            create(&path)?;
            return Ok(path);
        }
        while runs.len() > 1 {
            let mut next = Vec::new();
            let mut inputs = runs.into_iter();
            loop {
                let group: Vec<_> = inputs.by_ref().take(FAN_IN).collect();
                if group.is_empty() {
                    break;
                }
                next.push(if group.len() == 1 {
                    group.into_iter().next().unwrap()
                } else {
                    self.merged(group)?
                });
            }
            runs = next;
        }
        Ok(runs.pop().unwrap())
    }
}
fn merge(inputs: &[PathBuf], output: &Path, io_buffer: usize, cancel: &AtomicBool) -> Result<()> {
    let mut readers: Vec<_> = inputs
        .iter()
        .map(|p| File::open(p).map(|f| BufReader::with_capacity(io_buffer, f)))
        .collect::<std::io::Result<_>>()?;
    let mut heap = BinaryHeap::new();
    let mut writer = BufWriter::with_capacity(io_buffer, create(output)?);
    for (index, reader) in readers.iter_mut().enumerate() {
        if let Some(edge) = read_edge(reader)? {
            heap.push(Reverse((edge, index)));
        }
    }
    let mut previous = None;
    let mut steps = 0usize;
    while let Some(mut head) = heap.peek_mut() {
        let Reverse((edge, index)) = *head;
        if steps % 4096 == 0 {
            check(cancel)?;
        }
        steps += 1;
        if previous != Some((edge.0, edge.1)) {
            write_edge(&mut writer, edge)?;
            previous = Some((edge.0, edge.1));
        }
        if let Some(next) = read_edge(&mut readers[index])? {
            *head = Reverse((next, index));
        } else {
            std::collections::binary_heap::PeekMut::pop(head);
        }
    }
    writer.flush()?;
    Ok(())
}

pub struct DiskEdgeBuilder<'a> {
    sorter: Option<Sorter<'a>>,
    directory: &'a Path,
    nodes: usize,
    bytes: usize,
    cancel: &'a AtomicBool,
}
impl<'a> DiskEdgeBuilder<'a> {
    pub fn new(
        directory: &'a Path,
        nodes: usize,
        bytes: usize,
        cancel: &'a AtomicBool,
    ) -> Result<Self> {
        ensure!(nodes < u32::MAX as usize, "Too many graph nodes");
        Ok(Self {
            sorter: Some(Sorter::new(directory, "forward", bytes, cancel)?),
            directory,
            nodes,
            bytes,
            cancel,
        })
    }
    pub fn add_edge(&mut self, src: u32, dst: u32, label: u8) -> Result<()> {
        ensure!(
            (src as usize) < self.nodes
                && (dst as usize) < self.nodes
                && super::edge_store::label::valid(label),
            "Invalid edge"
        );
        self.sorter.as_mut().unwrap().add((src, dst, label))
    }
    pub fn build(self) -> Result<EdgeStore> {
        Ok(self.build_recorded()?.0)
    }
    pub(crate) fn build_recorded(
        mut self,
    ) -> Result<(EdgeStore, Vec<super::cache_writer::Receipt>)> {
        let timer = super::stage_timer::StageTimer::start("disk.forward_merge");
        let forward = self.sorter.take().unwrap().finish()?;
        drop(timer);
        let mut reverse = Sorter::new(self.directory, "reverse", self.bytes, self.cancel)?;
        let timer = super::stage_timer::StageTimer::start("disk.forward_columns");
        let mut receipts = self.columns(&forward, "forward", Some(&mut reverse))?;
        drop(timer);
        std::fs::remove_file(forward)?;
        let timer = super::stage_timer::StageTimer::start("disk.reverse_merge");
        let reverse_path = reverse.finish()?;
        drop(timer);
        let timer = super::stage_timer::StageTimer::start("disk.reverse_columns");
        receipts.extend(self.columns(&reverse_path, "reverse", None)?);
        drop(timer);
        std::fs::remove_file(reverse_path)?;
        Ok((EdgeStore::map(self.directory, self.nodes)?, receipts))
    }
    fn columns(
        &self,
        sorted: &Path,
        prefix: &str,
        mut reverse: Option<&mut Sorter<'a>>,
    ) -> Result<Vec<super::cache_writer::Receipt>> {
        let (_, io_buffer) = super::run_budget::split(self.bytes, 8192);
        let mut input = BufReader::with_capacity(io_buffer, File::open(sorted)?);
        let mut offsets = super::cache_writer::CacheWriter::new(
            self.directory,
            &format!("{prefix}.offsets"),
            self.cancel,
        )?;
        let mut targets = super::cache_writer::CacheWriter::new(
            self.directory,
            &format!("{prefix}.targets"),
            self.cancel,
        )?;
        let mut labels = if prefix == "forward" {
            Some(super::cache_writer::CacheWriter::new(
                self.directory,
                "forward.labels",
                self.cancel,
            )?)
        } else {
            None
        };
        let mut position = 0u32;
        let mut node = 0usize;
        offsets.write_all(&0u32.to_le_bytes())?;
        while let Some(edge) = read_edge(&mut input)? {
            if position % 4096 == 0 {
                check(self.cancel)?;
            }
            while node < edge.0 as usize {
                offsets.write_all(&position.to_le_bytes())?;
                node += 1;
            }
            targets.write_all(&edge.1.to_le_bytes())?;
            if let Some(labels) = &mut labels {
                labels.write_all(&[edge.2])?;
            }
            if let Some(reverse) = &mut reverse {
                reverse.add((edge.1, edge.0, edge.2))?;
            }
            position = position
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Too many graph edges"))?;
        }
        while node < self.nodes {
            offsets.write_all(&position.to_le_bytes())?;
            node += 1;
        }
        let mut receipts = vec![offsets.finish()?, targets.finish()?];
        if let Some(labels) = labels {
            receipts.push(labels.finish()?);
        }
        Ok(receipts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed::edge_store::EdgeBuilder;
    #[test]
    fn fixed_edges_cross_buffer_boundaries_and_truncation_is_not_eof() {
        let edges = [(0, u32::MAX, 6), (u32::MAX, 0, 0), (17, 29, 2)];
        let mut bytes = Vec::new();
        for edge in edges {
            write_edge(&mut bytes, edge).unwrap();
        }
        for capacity in 1..40 {
            let mut reader = BufReader::with_capacity(capacity, &bytes[..]);
            for edge in edges {
                assert_eq!(read_edge(&mut reader).unwrap(), Some(edge));
            }
            assert_eq!(read_edge(&mut reader).unwrap(), None);
            for cut in 1..9 {
                assert!(read_edge(&mut BufReader::with_capacity(capacity, &bytes[..cut])).is_err());
            }
        }
    }
    #[test]
    fn tiny_spills_match_memory_csr_with_null_empty_duplicate_and_shared_targets() {
        for nodes in [1, 32, 127] {
            let dir = tempfile::tempdir().unwrap();
            let cancel = AtomicBool::new(false);
            let mut disk = DiskEdgeBuilder::new(dir.path(), nodes, 48, &cancel).unwrap();
            let mut memory = EdgeBuilder::new();
            for i in 0..3000u32 {
                let src = i % nodes as u32;
                let dst = (i * 13) % nodes as u32;
                let label = (i % 7) as u8;
                disk.add_edge(src, dst, label).unwrap();
                memory.add_edge(src, dst, label);
            }
            let disk = disk.build().unwrap();
            let memory = memory.build(nodes);
            assert_eq!(disk.edge_count(), memory.edge_count());
            for i in 0..nodes as u32 {
                assert_eq!(disk.neighbor_labels(i), memory.neighbor_labels(i));
                assert_eq!(disk.reverse_neighbors(i), memory.reverse_neighbors(i));
            }
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 5);
        }
    }
    #[test]
    fn cancellation_and_invalid_edges_fail_without_publishing() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(true);
        let mut disk = DiskEdgeBuilder::new(dir.path(), 2, 48, &cancel).unwrap();
        assert!(disk.add_edge(0, 1, 0).is_err());
        assert!(disk.add_edge(0, 2, 0).is_err());
    }
}
