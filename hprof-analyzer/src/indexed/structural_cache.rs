//! Content-addressed structural indices published by one atomic directory rename.
//! Cache files and the original capture must remain immutable while mapped.
use super::{
    edge_store::EdgeStore,
    parse::{Phase1Result, Phase2Result},
    storage::StorageReport,
};
use anyhow::{ensure, Context, Result};
use std::{
    fs::{DirBuilder, File},
    io::{BufReader, BufWriter, Write},
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
const ABI: &str = "structure-v10-mapped-catalogs-blake3-sizing-v2-strong-class-v3";
const FILES: [&str; 9] = [
    "nodes.bin",
    "metadata.bin",
    "forward.offsets",
    "forward.targets",
    "forward.labels",
    "reverse.offsets",
    "reverse.targets",
    "instance.bodies",
    "arrays.bin",
];
use super::cache_writer::Receipt as Entry;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    abi: String,
    engine_version: String,
    digest_algorithm: String,
    input_digest: String,
    input_bytes: usize,
    files: Vec<Entry>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unmap_publish_and_remap_preserves_results_without_rebuilding_the_graph() {
        use crate::indexed::{HeapAnalysis, IndexedAnalysisState};
        let bytes = super::super::waste::tests::string_fixture();
        let mut input = memmap2::MmapMut::map_anon(bytes.len()).unwrap();
        input.copy_from_slice(&bytes);
        let input = Arc::new(input.make_read_only().unwrap());
        let cancel = AtomicBool::new(false);
        let (one, two, _) = super::super::storage::load_structure(
            input.clone(), &super::super::storage::StorageOptions::default(), &cancel,
        ).unwrap();
        let expected = IndexedAnalysisState::from_phases(one, two).unwrap();
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        for status in ["built", "reused"] {
            let mut stages = Vec::new();
            let (one, two, report) = load_with_publication(
                input.clone(), root.path(), 1024 * 1024, &cancel,
                &mut |event| stages.push(event.payload()), true,
            ).unwrap();
            assert_eq!(report.cache_status, status);
            assert!(!one.class_histogram.is_empty());
            let actual = IndexedAnalysisState::from_phases(one, two).unwrap();
            assert_eq!(actual.get_summary(), expected.get_summary());
            assert_eq!(actual.get_class_histogram(), expected.get_class_histogram());
            let query = "SELECT object_id, shallow_size, retained_size FROM instances ORDER BY object_id";
            assert_eq!(actual.execute_query(query).unwrap().rows, expected.execute_query(query).unwrap().rows);
            assert_eq!(actual.get_waste_analysis(), expected.get_waste_analysis());
            if status == "built" {
                assert_eq!(stages.iter().filter(|event| event["stage"] == "edges").count(), 1);
            } else {
                assert!(!stages.iter().any(|event| event["stage"] == "edges"));
            }
        }
    }
    #[test]
    fn manifest_receipts_require_independent_persisted_byte_verification() {
        let stage = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut files = Vec::new();
        for name in FILES {
            let mut output =
                super::super::cache_writer::CacheWriter::new(stage.path(), name, &cancel).unwrap();
            output.write_all(b"expected persisted bytes").unwrap();
            files.push(output.finish().unwrap());
        }
        let manifest = Manifest {
            abi: ABI.into(),
            engine_version: env!("CARGO_PKG_VERSION").into(),
            digest_algorithm: super::super::cache_digest::ALGORITHM.into(),
            input_digest: "test".into(),
            input_bytes: 5,
            files,
        };
        std::fs::write(
            stage.path().join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        validate(stage.path(), 5, "test", &cancel).unwrap();
        std::fs::write(stage.path().join("nodes.bin"), b"tampered persisted bytes").unwrap();
        assert!(validate(stage.path(), 5, "test", &cancel).is_err());
    }
}
fn private_directory(root: &Path) -> Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(root)?;
    let metadata = std::fs::symlink_metadata(root)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Cache root must be a real directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Cache root must be private (permissions 0700)"
        );
    }
    Ok(())
}
fn validate(directory: &Path, input_bytes: usize, key: &str, cancel: &AtomicBool) -> Result<()> {
    let metadata = std::fs::symlink_metadata(directory)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Invalid index directory"
    );
    let manifest_path = directory.join("manifest.json");
    let manifest_metadata = std::fs::symlink_metadata(&manifest_path)?;
    ensure!(
        manifest_metadata.is_file()
            && !manifest_metadata.file_type().is_symlink()
            && manifest_metadata.len() < 16384,
        "Invalid index manifest"
    );
    let manifest: Manifest = serde_json::from_reader(BufReader::new(File::open(manifest_path)?))?;
    ensure!(
        manifest.abi == ABI
            && manifest.engine_version == env!("CARGO_PKG_VERSION")
            && manifest.digest_algorithm == super::cache_digest::ALGORITHM
            && manifest.input_digest == key
            && manifest.input_bytes == input_bytes,
        "Stale structural index"
    );
    ensure!(
        manifest.files.len() == FILES.len(),
        "Incomplete structural index"
    );
    for (expected, entry) in FILES.iter().zip(&manifest.files) {
        ensure!(&entry.name == expected, "Invalid index inventory");
        let (bytes, digest) = super::cache_digest::file(&directory.join(expected), cancel)?;
        ensure!(
            bytes == entry.bytes && digest == entry.digest,
            "Corrupt structural index"
        );
    }
    Ok(())
}
fn read(
    directory: &Path,
    mapping: Arc<memmap2::Mmap>,
    key: &str,
    cancel: &AtomicBool,
) -> Result<(Phase1Result, Phase2Result)> {
    {
        let _timer = super::stage_timer::StageTimer::start("index.component_verification");
        validate(directory, mapping.len(), key, cancel)?;
    }
    let _load_timer = super::stage_timer::StageTimer::start("index.mapped_load_and_validation");
    let input_bytes = mapping.len();
    let mut phase1 = super::cache_format::read(directory, mapping, cancel)?;
    // Derive graph provenance from the validated ABI, not optional text in
    // persisted metadata. Historical report deserialization stays unchanged.
    if let Some(model) = phase1.summary.size_model.as_mut() {
        model.retained_size_policy = Some(crate::reference_strength::RETAINED_SIZE_POLICY.into());
    }
    let edges = EdgeStore::map(directory, phase1.node_store.len())?;
    let phase2 = Phase2Result {
        object_bodies: Some(super::object_bodies::ObjectBodies::map_cancellable(
            directory,
            phase1.node_store.len(),
            input_bytes,
            cancel,
        )?),
        edge_store: edges,
        waste_raw: phase1.waste_raw.clone(),
    };
    Ok((phase1, phase2))
}
pub(crate) fn load(
    mapping: Arc<memmap2::Mmap>,
    root: &Path,
    bytes: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(super::progress::Observation<'_>),
) -> Result<(Phase1Result, Phase2Result, StorageReport)> {
    load_with_publication(mapping, root, bytes, cancel, progress, cfg!(windows))
}
fn load_with_publication(
    mapping: Arc<memmap2::Mmap>,
    root: &Path,
    bytes: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(super::progress::Observation<'_>),
    release_mappings: bool,
) -> Result<(Phase1Result, Phase2Result, StorageReport)> {
    private_directory(root)?;
    progress(super::progress::Observation::Stage("index_verifying"));
    let key = {
        let _timer = super::stage_timer::StageTimer::start("index.input_digest");
        super::cache_digest::bytes(&mapping, cancel)?
    };
    let directory = root.join(format!("{ABI}-{}-{key}", env!("CARGO_PKG_VERSION")));
    if directory.exists() {
        let (mut phase1, phase2) = read(&directory, mapping, &key, cancel).context("Structural index rejected; use a new private cache directory or remove only this invalid entry")?;
        // Structural metadata intentionally omits derived histograms. Rebuild
        // the exact shallow values before advertising Histogram readiness.
        {
            let _timer = super::stage_timer::StageTimer::start("index.shallow_histogram");
            phase1.class_histogram = super::parse_metadata::shallow_histogram_cancellable(&phase1.node_store,
                &mut || cancel.load(std::sync::atomic::Ordering::Relaxed))?;
        }
        super::disk_edges::check(cancel)?;
        progress(super::progress::Observation::Shallow { summary:&phase1.summary, histogram:&phase1.class_histogram });
        return Ok((
            phase1,
            phase2,
            StorageReport {
                mode: "disk",
                cache_status: "reused",
                edge_buffer_bytes: bytes,
            },
        ));
    }
    let stage = tempfile::Builder::new()
        .prefix("building-")
        .tempdir_in(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(stage.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    let (mut phase1, deferred) = super::parse::parse_indexed_phase1_disk(mapping.clone(), stage.path(), bytes, cancel, progress)
        .context("Constructing disk node catalog")?;
    super::disk_edges::check(cancel)?;
    progress(super::progress::Observation::Stage("edges"));
    let (mut phase2, mut receipts) = super::parse::parse_indexed_phase2_disk_recorded(
        &phase1,
        deferred,
        stage.path(),
        bytes,
        cancel,
    ).context("Constructing disk reference graph")?;
    progress(super::progress::Observation::Stage("index_publishing"));
    receipts.extend(super::cache_format::write(&mut phase1, stage.path(), cancel)
        .context("Freezing disk node catalog")?);
    // Drop the second owner before freezing, never clone object-sized candidates.
    phase2.waste_raw = Arc::new(crate::waste::WasteRawData::new());
    super::cache_format::freeze_waste(&mut phase1, stage.path(), cancel)
        .context("Freezing disk content catalog")?;
    phase2.waste_raw = phase1.waste_raw.clone();
    let mut files = Vec::new();
    for name in FILES {
        let position = receipts
            .iter()
            .position(|entry| entry.name == name)
            .ok_or_else(|| anyhow::anyhow!("Missing cache write receipt"))?;
        files.push(receipts.remove(position));
    }
    ensure!(receipts.is_empty(), "Unexpected cache write receipt");
    let manifest = Manifest {
        abi: ABI.into(),
        engine_version: env!("CARGO_PKG_VERSION").into(),
        digest_algorithm: super::cache_digest::ALGORITHM.into(),
        input_digest: key.clone(),
        input_bytes: mapping.len(),
        files,
    };
    let mut writer = BufWriter::new(super::disk_edges::create(
        &stage.path().join("manifest.json"),
    )?);
    serde_json::to_writer(&mut writer, &manifest)?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    drop(writer);
    super::disk_edges::check(cancel)?;
    // Validate the newly written files before making them a reusable entry.
    validate(stage.path(), mapping.len(), &key, cancel).context("Verifying new disk index")?;
    super::disk_edges::check(cancel)?;
    // Windows cannot rename this directory while its files are mapped. Keep
    // only the class-level shallow histogram, not another node/graph copy.
    // The published files are verified and mapped again after all old views
    // have been dropped. Unix retains the existing zero-remap fast path.
    let histogram = std::mem::take(&mut phase1.class_histogram);
    let phases = if release_mappings {
        drop((phase1, phase2));
        None
    } else {
        Some((phase1, phase2))
    };
    match std::fs::rename(stage.path(), &directory) {
        Ok(()) => {
            #[cfg(unix)]
            File::open(root)?.sync_all()?;
            let (mut phase1, phase2) = match phases {
                Some(phases) => phases,
                None => read(&directory, mapping, &key, cancel)
                    .context("Mapping published disk index")?,
            };
            phase1.class_histogram = histogram;
            Ok((
                phase1,
                phase2,
                StorageReport {
                    mode: "disk",
                    cache_status: "built",
                    edge_buffer_bytes: bytes,
                },
            ))
        }
        Err(error) => {
            drop(phases);
            // A concurrent builder may have published the same complete entry.
            if directory.exists() {
                let (phase1, phase2) = read(&directory, mapping, &key, cancel)?;
                Ok((
                    phase1,
                    phase2,
                    StorageReport {
                        mode: "disk",
                        cache_status: "reused",
                        edge_buffer_bytes: bytes,
                    },
                ))
            } else {
                Err(error).context("Publishing disk index directory")
            }
        }
    }
}
