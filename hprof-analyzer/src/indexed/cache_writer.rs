//! Checksums reflect successful writes, not a second read to create the manifest.
//! Publication still independently verifies the persisted files before rename.
use anyhow::Result;
use std::{
    fs::File,
    io::{self, BufWriter, Write},
    path::Path,
    sync::atomic::AtomicBool,
};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    pub name: String,
    pub bytes: u64,
    pub digest: String,
}

struct DigestSink<W> {
    inner: W,
    hasher: blake3::Hasher,
    bytes: u64,
}
impl<W: Write> Write for DigestSink<W> {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(input)?;
        self.bytes = self
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("Cache size overflow"))?;
        self.hasher.update(&input[..count]);
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub(crate) struct CacheWriter<'a> {
    output: BufWriter<DigestSink<File>>,
    name: String,
    cancel: &'a AtomicBool,
}
impl<'a> CacheWriter<'a> {
    pub(crate) fn new(directory: &Path, name: &str, cancel: &'a AtomicBool) -> Result<Self> {
        super::disk_edges::check(cancel)?;
        Ok(Self {
            output: BufWriter::with_capacity(
                1024 * 1024,
                DigestSink {
                    inner: super::disk_edges::create(&directory.join(name))?,
                    hasher: blake3::Hasher::new(),
                    bytes: 0,
                },
            ),
            name: name.into(),
            cancel,
        })
    }
    pub(crate) fn finish(mut self) -> Result<Receipt> {
        super::disk_edges::check(self.cancel)?;
        self.output.flush()?;
        self.output.get_ref().inner.sync_all()?;
        super::disk_edges::check(self.cancel)?;
        let sink = self.output.get_ref();
        Ok(Receipt {
            name: self.name,
            bytes: sink.bytes,
            digest: sink.hasher.finalize().to_hex().to_string(),
        })
    }
}
impl Write for CacheWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // Checking at every logical write also bounds cancellation in metadata loops.
        super::disk_edges::check(self.cancel).map_err(io::Error::other)?;
        self.output.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_writes_and_errors_hash_only_accepted_bytes() {
        struct Short(Vec<u8>);
        impl Write for Short {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                if self.0.len() >= 6 {
                    return Err(io::Error::other("injected failure"));
                }
                let n = b.len().min(3);
                self.0.extend_from_slice(&b[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut sink = DigestSink {
            inner: Short(vec![]),
            hasher: blake3::Hasher::new(),
            bytes: 0,
        };
        assert!(sink.write_all(b"abcdefghij").is_err());
        assert_eq!(sink.bytes, 6);
        assert_eq!(sink.hasher.finalize(), blake3::hash(b"abcdef"));
    }
    #[test]
    fn receipt_matches_persisted_bytes_including_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        for (name, bytes) in [("empty", vec![]), ("large", vec![17; 3 * 1024 * 1024 + 3])] {
            let mut out = CacheWriter::new(dir.path(), name, &cancel).unwrap();
            out.write_all(&bytes).unwrap();
            let receipt = out.finish().unwrap();
            let (length, digest) =
                super::super::cache_digest::file(&dir.path().join(name), &cancel).unwrap();
            assert_eq!(receipt.bytes, length);
            assert_eq!(receipt.digest, digest);
        }
    }
    #[test]
    fn cancellation_never_produces_a_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut out = CacheWriter::new(dir.path(), "partial", &cancel).unwrap();
        out.write_all(b"unfinished").unwrap();
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(out.write_all(b"more").is_err());
        assert!(out.finish().is_err());
    }
}
