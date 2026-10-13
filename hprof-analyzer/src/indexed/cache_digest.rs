//! Full-content verification shared by cache identity and component checks.
//! No sampled keys: every byte contributes. Inputs must stay immutable while mapped.
use anyhow::{ensure, Result};
use std::{
    fs::File,
    path::Path,
    sync::{atomic::AtomicBool, OnceLock},
};

pub(super) const ALGORITHM: &str = "blake3-256";
const MAX_WORKERS: usize = 8;
const CHECK_INTERVAL_BYTES: usize = 16 * 1024 * 1024;
const PARALLEL_THRESHOLD_BYTES: usize = 1024 * 1024;
static WORKERS: OnceLock<Result<rayon::ThreadPool, String>> = OnceLock::new();

fn workers() -> Result<&'static rayon::ThreadPool> {
    match WORKERS.get_or_init(|| {
        let count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .min(MAX_WORKERS);
        rayon::ThreadPoolBuilder::new()
            .num_threads(count)
            .thread_name(|index| format!("heaplens-verify-{index}"))
            .build()
            .map_err(|error| error.to_string())
    }) {
        Ok(pool) => Ok(pool),
        Err(_) => anyhow::bail!("Cannot start verification worker pool"),
    }
}

fn checked_digest(input: &[u8], mut check: impl FnMut() -> Result<()>) -> Result<String> {
    check()?;
    let mut hasher = blake3::Hasher::new();
    for chunk in input.chunks(CHECK_INTERVAL_BYTES) {
        check()?;
        if chunk.len() >= PARALLEL_THRESHOLD_BYTES {
            workers()?.install(|| {
                hasher.update_rayon(chunk);
            });
        } else {
            hasher.update(chunk);
        }
    }
    check()?;
    Ok(hasher.finalize().to_hex().to_string())
}

pub(super) fn bytes(input: &[u8], cancel: &AtomicBool) -> Result<String> {
    checked_digest(input, || super::disk_edges::check(cancel))
}

pub(super) fn file(path: &Path, cancel: &AtomicBool) -> Result<(u64, String)> {
    super::disk_edges::check(cancel)?;
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Index file must be a regular file"
    );
    let file = File::open(path)?;
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() == metadata.len(),
        "Index file changed before verification"
    );
    if metadata.len() == 0 {
        return Ok((0, bytes(&[], cancel)?));
    }
    // Like the structural columns, cache components are immutable while open.
    // Map rather than allocate a file-sized buffer, and drop this view before publication.
    let mapping = unsafe { memmap2::Mmap::map(&file)? };
    ensure!(
        mapping.len() as u64 == metadata.len(),
        "Invalid index mapping length"
    );
    let digest = bytes(&mapping, cancel)?;
    ensure!(
        file.metadata()?.len() == metadata.len(),
        "Index file changed during verification"
    );
    Ok((metadata.len(), digest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn empty_digest_matches_the_blake3_vector_and_cancel_still_wins() {
        let cancel = AtomicBool::new(false);
        assert_eq!(
            bytes(&[], &cancel).unwrap(),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        cancel.store(true, Ordering::Relaxed);
        assert!(bytes(&[], &cancel).is_err());
    }

    #[test]
    fn bounded_parallel_updates_match_serial_at_chunk_and_tree_boundaries() {
        for length in [
            1,
            1023,
            1024,
            1025,
            PARALLEL_THRESHOLD_BYTES - 1,
            PARALLEL_THRESHOLD_BYTES,
            CHECK_INTERVAL_BYTES - 1,
            CHECK_INTERVAL_BYTES,
            CHECK_INTERVAL_BYTES + 1,
            2 * CHECK_INTERVAL_BYTES + 127,
        ] {
            let input: Vec<u8> = (0..length)
                .map(|index| (index.wrapping_mul(17) % 251) as u8)
                .collect();
            assert_eq!(
                bytes(&input, &AtomicBool::new(false)).unwrap(),
                blake3::hash(&input).to_hex().to_string()
            );
        }
        assert!((1..=MAX_WORKERS).contains(&workers().unwrap().current_num_threads()));
    }

    #[test]
    fn cancellation_after_a_completed_chunk_returns_no_digest() {
        let input = vec![7; 2 * CHECK_INTERVAL_BYTES + 1];
        let cancel = AtomicBool::new(false);
        let mut checks = 0;
        let result = checked_digest(&input, || {
            checks += 1;
            if checks == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
            super::super::disk_edges::check(&cancel)
        });
        assert!(result.is_err());
        assert_eq!(checks, 3);
    }

    #[test]
    fn changed_middle_byte_changes_the_full_content_digest() {
        let mut input = vec![9; CHECK_INTERVAL_BYTES + 7];
        let before = bytes(&input, &AtomicBool::new(false)).unwrap();
        input[CHECK_INTERVAL_BYTES / 2 + 37] ^= 1;
        assert_ne!(bytes(&input, &AtomicBool::new(false)).unwrap(), before);
    }

    #[test]
    fn mapped_files_match_slice_digests_including_empty_components() {
        let root = tempfile::tempdir().unwrap();
        for length in [0, 31, PARALLEL_THRESHOLD_BYTES, CHECK_INTERVAL_BYTES + 19] {
            let input = vec![13; length];
            let path = root.path().join(format!("component-{length}"));
            std::fs::write(&path, &input).unwrap();
            assert_eq!(
                file(&path, &AtomicBool::new(false)).unwrap(),
                (length as u64, blake3::hash(&input).to_hex().to_string())
            );
            assert!(file(&path, &AtomicBool::new(true)).is_err());
        }
        assert!(file(root.path(), &AtomicBool::new(false)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn component_symlinks_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let regular = root.path().join("regular");
        let link = root.path().join("link");
        std::fs::write(&regular, b"contents").unwrap();
        std::os::unix::fs::symlink(&regular, &link).unwrap();
        assert!(file(&link, &AtomicBool::new(false)).is_err());
    }
}
