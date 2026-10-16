//! Storage policy shared by terminal CLI and every stdio-server host.
use super::parse::{Phase1Result, Phase2Result};
use anyhow::{ensure, Result};
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
pub use super::resource_lease::ResourceError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageMode {
    Memory,
    Disk,
}
impl StorageMode {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "memory" => Ok(Self::Memory),
            "disk" => Ok(Self::Disk),
            _ => anyhow::bail!("Storage must be memory or disk"),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Disk => "disk",
        }
    }
}
#[derive(Clone, Debug)]
pub struct StorageOptions {
    pub mode: StorageMode,
    pub cache_dir: Option<PathBuf>,
    /// Edge-sort scratch buffer only, not an RSS limit.
    pub edge_buffer_bytes: usize,
}
impl Default for StorageOptions {
    fn default() -> Self {
        Self {
            mode: StorageMode::Memory,
            cache_dir: None,
            edge_buffer_bytes: 64 * 1024 * 1024,
        }
    }
}
impl StorageOptions {
    pub fn from_env() -> Result<Self> {
        let mut value = Self::default();
        if let Ok(mode) = std::env::var("HEAPLENS_STORAGE") {
            value.mode = StorageMode::parse(&mode)?;
        }
        value.cache_dir = std::env::var_os("HEAPLENS_CACHE_DIR").map(PathBuf::from);
        if let Ok(bytes) = std::env::var("HEAPLENS_EDGE_BUFFER_MIB") {
            value.set_buffer_mib(bytes.parse()?)?;
        }
        Ok(value)
    }
    pub fn set_buffer_mib(&mut self, mib: usize) -> Result<()> {
        ensure!(
            (1..=1024).contains(&mib),
            "Edge buffer must be 1 to 1024 MiB"
        );
        self.edge_buffer_bytes = mib * 1024 * 1024;
        Ok(())
    }
    pub fn directory(&self) -> Result<PathBuf> {
        if let Some(directory) = &self.cache_dir {
            ensure!(directory.is_absolute(), "Cache directory must be absolute");
            return Ok(directory.clone());
        }
        let base = if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
        } else if cfg!(target_os = "macos") {
            std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Caches"))
        } else {
            std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache")))
        };
        let base = base.ok_or_else(|| anyhow::anyhow!("Set an absolute cache directory"))?;
        ensure!(base.is_absolute(), "Cache base directory must be absolute");
        Ok(base.join("HeapLens/structure-v1"))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StorageReport {
    pub mode: &'static str,
    pub cache_status: &'static str,
    pub edge_buffer_bytes: usize,
}

pub fn load_structure(
    mapping: Arc<memmap2::Mmap>,
    options: &StorageOptions,
    cancel: &AtomicBool,
) -> Result<(Phase1Result, Phase2Result, StorageReport)> {
    load_structure_observed(mapping, options, cancel, &mut |_| {})
}

pub fn load_structure_observed(
    mapping: Arc<memmap2::Mmap>, options: &StorageOptions, cancel: &AtomicBool,
    progress: &mut dyn FnMut(super::progress::Observation<'_>),
) -> Result<(Phase1Result, Phase2Result, StorageReport)> {
    super::disk_edges::check(cancel)?;
    if options.mode == StorageMode::Memory {
        let (phase1, deferred) = super::parse::parse_indexed_phase1_observed(mapping, None, cancel, progress)?;
        super::disk_edges::check(cancel)?;
        progress(super::progress::Observation::Stage("edges"));
        let phase2 = super::parse::parse_indexed_phase2_cancellable(&phase1, deferred, cancel)?;
        return Ok((
            phase1,
            phase2,
            StorageReport {
                mode: "memory",
                cache_status: "disabled",
                edge_buffer_bytes: 0,
            },
        ));
    }
    ensure!(
        (1024 * 1024..=1024 * 1024 * 1024).contains(&options.edge_buffer_bytes),
        "Invalid edge buffer"
    );
    super::structural_cache::load(
        mapping,
        &options.directory()?,
        options.edge_buffer_bytes,
        cancel,
        progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed::{HeapAnalysis, IndexedAnalysisState};
    fn mapping(bytes: &[u8]) -> Arc<memmap2::Mmap> {
        let mut map = memmap2::MmapMut::map_anon(bytes.len()).unwrap();
        map.copy_from_slice(bytes);
        Arc::new(map.make_read_only().unwrap())
    }
    fn private_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        root
    }
    fn fixture() -> Arc<memmap2::Mmap> {
        mapping(&super::super::waste::tests::string_fixture())
    }
    #[test]
    fn phases_share_immutable_waste_candidates_without_copying() {
        let (one, deferred) = super::super::parse::parse_indexed_phase1_mapped(fixture(), None).unwrap();
        let two = super::super::parse::parse_indexed_phase2(&one, deferred).unwrap();
        assert!(Arc::ptr_eq(&one.waste_raw, &two.waste_raw));
        assert!(!one.waste_raw.string_instances.is_empty());
    }
    #[test]
    fn staged_memory_build_and_verified_reuse_publish_truthful_shallow_results() {
        let root=private_root();
        let mut expected=None;
        for options in [StorageOptions::default(),options(root.path()),options(root.path())] {
            let mut events=Vec::new();
            let (one,two,report)=load_structure_observed(fixture(),&options,&AtomicBool::new(false),
                &mut |event|events.push(event.payload())).unwrap();
            let shallow=events.iter().find(|event|event["snapshot"]["kind"]=="shallow").unwrap();
            assert!(shallow["snapshot"]["summary"]["reachable_heap_size"].is_null());
            assert_eq!(shallow["snapshot"]["readiness"]["retained"],"not_calculated");
            let actual = shallow["snapshot"]["class_histogram"].as_array().unwrap();
            assert!(!actual.is_empty(), "this fixture has histogram-eligible objects");
            let expected_shallow = super::super::parse_metadata::shallow_histogram(&one.node_store);
            assert_eq!(actual.len(), expected_shallow.len());
            for (actual, expected) in actual.iter().zip(&expected_shallow) {
                assert_eq!(actual["class_name"], expected.class_name);
                assert_eq!(actual["instance_count"], expected.instance_count);
                assert_eq!(actual["shallow_size"], expected.shallow_size);
            }
            for entry in shallow["snapshot"]["class_histogram"].as_array().unwrap() {
                assert!(entry.get("retained_size").is_none());
            }
            let state=IndexedAnalysisState::from_phases(one,two).unwrap();
            assert_eq!(shallow["snapshot"]["summary"]["total_heap_size"],state.get_summary().total_heap_size);
            let current=serde_json::to_value(state.get_summary()).unwrap();
            if let Some(expected)=&expected {assert_eq!(&current,expected);}else{expected=Some(current);}
            if report.cache_status=="reused" {
                assert_eq!(events[0]["stage"],"index_verifying");
                assert!(!events.iter().any(|event|event["stage"]=="sizing"));
            } else {
                let shallow_at=events.iter().position(|event|event["stage"]=="shallow_ready").unwrap();
                let edges_at=events.iter().position(|event|event["stage"]=="edges").unwrap();
                assert!(shallow_at<edges_at);
            }
        }
    }
    #[test]
    fn cancelling_after_shallow_results_never_publishes_a_partial_index() {
        let root=private_root();let cancel=AtomicBool::new(false);
        let result=load_structure_observed(fixture(),&options(root.path()),&cancel,&mut |event| {
            if matches!(event,super::super::progress::Observation::Shallow {..}) {
                cancel.store(true,std::sync::atomic::Ordering::Relaxed);
            }
        });
        assert!(result.is_err());assert!(cancel.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
    }
    #[test]
    fn bounded_single_pass_and_large_graph_replay_have_identical_csr_and_labels() {
        let input = fixture();
        let (one, deferred) = super::super::parse::parse_indexed_phase1_mapped(input.clone(), None).unwrap();
        assert!(super::super::memory_edges::single_pass(deferred.max_references));
        let fast = super::super::parse::parse_indexed_phase2(&one, deferred).unwrap();
        let (other, mut deferred) = super::super::parse::parse_indexed_phase1_mapped(input, None).unwrap();
        deferred.max_references = usize::MAX;
        let replay = super::super::parse::parse_indexed_phase2(&other, deferred).unwrap();
        for node in 0..one.node_store.len() as u32 {
            assert_eq!(fast.edge_store.neighbor_labels(node), replay.edge_store.neighbor_labels(node));
            assert_eq!(fast.edge_store.reverse_neighbors(node), replay.edge_store.reverse_neighbors(node));
        }
    }
    fn options(root: &std::path::Path) -> StorageOptions {
        StorageOptions {
            mode: StorageMode::Disk,
            cache_dir: Some(root.into()),
            edge_buffer_bytes: 1024 * 1024,
        }
    }
    fn load(
        input: Arc<memmap2::Mmap>,
        options: &StorageOptions,
    ) -> (IndexedAnalysisState, StorageReport) {
        let (one, two, report) = load_structure(input, options, &AtomicBool::new(false)).unwrap();
        (IndexedAnalysisState::from_phases(one, two).unwrap(), report)
    }
    fn entry(root: &std::path::Path) -> PathBuf {
        std::fs::read_dir(root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
    }
    #[test]
    fn built_and_reused_disk_indices_match_memory_for_every_graph_action_and_lazy_waste() {
        let root = private_root();
        let input = fixture();
        let (memory, _) = load(input.clone(), &StorageOptions::default());
        let (built, first) = load(input.clone(), &options(root.path()));
        let (reused, second) = load(input.clone(), &options(root.path()));
        assert_eq!(first.cache_status, "built");
        assert_eq!(second.cache_status, "reused");
        for disk in [&built, &reused] {
            assert!(disk.cached_waste_analysis().is_none());
            assert_eq!(disk.get_summary(), memory.get_summary());
            assert_eq!(disk.get_class_histogram(), memory.get_class_histogram());
            let query="SELECT object_id, class_name, shallow_size, retained_size FROM instances ORDER BY object_id";
            let actual = disk.execute_query(query).unwrap();
            let expected = memory.execute_query(query).unwrap();
            assert_eq!(actual.columns, expected.columns);
            assert_eq!(actual.rows, expected.rows);
            for id in [0, 100, 200, 201, 202, 300, 304, 999] {
                assert_eq!(
                    serde_json::to_value(disk.get_children(id)).unwrap(),
                    serde_json::to_value(memory.get_children(id)).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(disk.gc_root_path(id, 20)).unwrap(),
                    serde_json::to_value(memory.gc_root_path(id, 20)).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(disk.inspect_object_bytes(&input, id)).unwrap(),
                    serde_json::to_value(memory.inspect_object_bytes(&input, id)).unwrap()
                );
            }
            assert_eq!(disk.get_waste_analysis(), memory.get_waste_analysis());
        }
        let metadata = std::fs::read(entry(root.path()).join("metadata.bin")).unwrap();
        assert!(metadata.starts_with(b"HLMETA03"));
        assert!(!entry(root.path()).join("metadata.json").exists());
        assert_eq!(std::fs::read_dir(entry(root.path())).unwrap().count(), 9);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for file in std::fs::read_dir(entry(root.path())).unwrap() {
                assert_eq!(
                    file.unwrap().metadata().unwrap().permissions().mode() & 0o077,
                    0
                );
            }
        }
    }
    #[test]
    fn mapped_instance_bodies_and_object_array_ids_are_not_copied() {
        let input = fixture();
        let (one, deferred) =
            super::super::parse::parse_indexed_phase1_mapped(input.clone(), None).unwrap();
        assert!(deferred.deferred_instances.iter().all(|record| matches!(
            record.field_bytes,
            super::super::parse::DeferredBytes::Mapped { .. }
        )));
        drop(input);
        super::super::parse::parse_indexed_phase2(&one, deferred).unwrap();
        // Borrowed public parsing remains self-contained after input is released.
        let bytes = super::super::waste::tests::string_fixture();
        let (one, deferred) = super::super::parse::parse_indexed_phase1(&bytes).unwrap();
        assert!(deferred.deferred_instances.iter().all(|record| matches!(
            record.field_bytes,
            super::super::parse::DeferredBytes::Owned(_)
        )));
        drop(bytes);
        super::super::parse::parse_indexed_phase2(&one, deferred).unwrap();
    }
    #[test]
    fn corrupt_and_incompatible_indices_fail_closed_without_deleting_data() {
        for file in [
            "forward.offsets",
            "forward.targets",
            "forward.labels",
            "reverse.offsets",
            "reverse.targets",
            "instance.bodies",
            "metadata.bin",
            "manifest.json",
            "nodes.bin",
        ] {
            let root = private_root();
            let input = fixture();
            load(input.clone(), &options(root.path()));
            let path = entry(root.path()).join(file);
            let mut bytes = std::fs::read(&path).unwrap();
            bytes[0] ^= 1;
            std::fs::write(&path, &bytes).unwrap();
            assert!(load_structure(input, &options(root.path()), &AtomicBool::new(false)).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        }
    }
    #[test]
    fn same_length_changed_payload_uses_a_different_content_key() {
        let root = private_root();
        let mut bytes = super::super::waste::tests::string_fixture();
        load(mapping(&bytes), &options(root.path()));
        let position = bytes.len() - 10;
        bytes[position] ^= 1;
        let (_, report) = load(mapping(&bytes), &options(root.path()));
        assert_eq!(report.cache_status, "built");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }
    #[test]
    fn structural_cache_declares_blake3_and_a_new_abi() {
        let root = private_root();
        load(fixture(), &options(root.path()));
        let directory = entry(root.path());
        assert!(directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("structure-v9-bodies-blake3-"));
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["digest_algorithm"], "blake3-256");
        assert_eq!(manifest["input_digest"].as_str().unwrap().len(), 64);
        assert!(manifest.get("input_sha256").is_none());
        for file in manifest["files"].as_array().unwrap() {
            assert_eq!(file["digest"].as_str().unwrap().len(), 64);
            assert!(file.get("sha256").is_none());
        }
    }
    #[test]
    fn old_sha256_namespace_is_preserved_and_not_reused() {
        let root = private_root();
        let legacy = root.path().join(format!(
            "structure-v1-sizing-v1-strong-v1-{}-{}",
            env!("CARGO_PKG_VERSION"),
            "a".repeat(64)
        ));
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("manifest.json"), b"preserved old cache").unwrap();
        assert_eq!(
            load(fixture(), &options(root.path())).1.cache_status,
            "built"
        );
        assert_eq!(
            load(fixture(), &options(root.path())).1.cache_status,
            "reused"
        );
        assert_eq!(
            std::fs::read(legacy.join("manifest.json")).unwrap(),
            b"preserved old cache"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn previous_blake3_json_namespace_is_preserved_and_not_reused() {
        let root = private_root();
        let old = root.path().join("structure-v2-blake3-sizing-v1-strong-v1-old");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("metadata.json"), b"preserved old metadata").unwrap();
        let (_, report) = load(fixture(), &options(root.path()));
        assert_eq!(report.cache_status, "built");
        assert_eq!(std::fs::read(old.join("metadata.json")).unwrap(), b"preserved old metadata");
        let (_, report) = load(fixture(), &options(root.path()));
        assert_eq!(report.cache_status, "reused");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }
    #[test]
    fn previous_wide_body_namespace_is_preserved_and_not_reused() {
        let root = private_root();
        let old = root.path().join("structure-v3-columns-blake3-sizing-v1-strong-v1-old");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("instance.bodies"), b"preserve wide records").unwrap();
        assert_eq!(load(fixture(), &options(root.path())).1.cache_status, "built");
        assert_eq!(load(fixture(), &options(root.path())).1.cache_status, "reused");
        assert_eq!(std::fs::read(old.join("instance.bodies")).unwrap(), b"preserve wide records");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }
    #[test]
    fn previous_incomplete_class_graph_is_preserved_and_never_reused() {
        for namespace in ["structure-v4-bodies-blake3-sizing-v1-strong-v1-old",
            "structure-v5-bodies-blake3-sizing-v1-strong-class-v2-old"] {
        let root = private_root();
        let old = root.path().join(namespace);
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("manifest.json"), b"preserve pre-correction graph").unwrap();
        assert_eq!(load(fixture(), &options(root.path())).1.cache_status, "built");
        assert_eq!(load(fixture(), &options(root.path())).1.cache_status, "reused");
        assert_eq!(std::fs::read(old.join("manifest.json")).unwrap(), b"preserve pre-correction graph");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
        }
    }
    #[test]
    fn mismatched_digest_algorithm_is_rejected_before_cache_loading() {
        let root = private_root();
        let input = fixture();
        load(input.clone(), &options(root.path()));
        let path = entry(root.path()).join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        manifest["digest_algorithm"] = serde_json::json!("sha256");
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(load_structure(input, &options(root.path()), &AtomicBool::new(false)).is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    #[test]
    fn invalid_input_and_cancelled_work_do_not_publish_partial_entries() {
        let root = private_root();
        let invalid = mapping(b"invalid capture");
        assert!(load_structure(invalid, &options(root.path()), &AtomicBool::new(false)).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        assert!(load_structure(fixture(), &options(root.path()), &AtomicBool::new(true)).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
    #[test]
    fn concurrent_builders_share_one_valid_published_entry() {
        let root = private_root();
        let input = fixture();
        let options = options(root.path());
        std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| load(input.clone(), &options)))
                .collect();
            for job in jobs {
                let (state, _) = job.join().unwrap();
                assert_eq!(state.get_summary().total_instances, 5);
            }
        });
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        assert_eq!(load(input, &options).1.cache_status, "reused");
    }
    #[test]
    fn incomplete_build_directories_are_ignored_and_unrelated_files_preserved() {
        let root = private_root();
        let sentinel = root.path().join("building-stopped");
        std::fs::create_dir(&sentinel).unwrap();
        std::fs::write(sentinel.join("user-data"), b"preserve").unwrap();
        assert_eq!(
            load(fixture(), &options(root.path())).1.cache_status,
            "built"
        );
        assert_eq!(
            std::fs::read(sentinel.join("user-data")).unwrap(),
            b"preserve"
        );
    }
    #[cfg(unix)]
    #[test]
    fn public_cache_directory_and_symlink_roots_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = private_root();
        let options = options(root.path());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(load_structure(fixture(), &options, &AtomicBool::new(false)).is_err());
        let parent = private_root();
        let link = parent.path().join("link");
        symlink(root.path(), &link).unwrap();
        assert!(load_structure(
            fixture(),
            &super::tests::options(&link),
            &AtomicBool::new(false)
        )
        .is_err());
    }

    #[test]
    fn mapped_object_arrays_keep_encoded_ranges_and_resolve_null_shared_ids_at_both_widths() {
        fn id(out: &mut Vec<u8>, value: u64, width: u32) {
            if width == 4 {
                out.extend((value as u32).to_be_bytes());
            } else {
                out.extend(value.to_be_bytes());
            }
        }
        for width in [4u32, 8] {
            let mut bytes = b"JAVA PROFILE 1.0.2\0".to_vec();
            bytes.extend(width.to_be_bytes());
            bytes.extend(0u64.to_be_bytes());
            let mut heap = vec![0xff];
            id(&mut heap, 1024, width);
            heap.push(0x22);
            id(&mut heap, 1024, width);
            heap.extend(0u32.to_be_bytes());
            heap.extend(4u32.to_be_bytes());
            id(&mut heap, 2000, width);
            for value in [512, 0, 768, 512] {
                id(&mut heap, value, width);
            }
            for value in [512, 768] {
                heap.push(0x23);
                id(&mut heap, value, width);
                heap.extend(0u32.to_be_bytes());
                heap.extend(1u32.to_be_bytes());
                heap.extend([8, 7]);
            }
            bytes.push(0x1c);
            bytes.extend(0u32.to_be_bytes());
            bytes.extend((heap.len() as u32).to_be_bytes());
            bytes.extend(heap);
            bytes.push(0x2c);
            bytes.extend([0u8; 8]);
            let input = mapping(&bytes);
            let (one, deferred) =
                super::super::parse::parse_indexed_phase1_mapped(input.clone(), None).unwrap();
            assert_eq!(deferred.deferred_arrays.len(), 1);
            assert!(
                matches!(deferred.deferred_arrays.iter().next().unwrap().field_bytes,super::super::parse::DeferredBytes::Mapped{length,..} if length==width as usize*4)
            );
            let two = super::super::parse::parse_indexed_phase2(&one, deferred).unwrap();
            let memory = IndexedAnalysisState::from_phases(one, two).unwrap();
            let root = private_root();
            let (disk, _) = load(input, &options(root.path()));
            assert_eq!(memory.get_summary(), disk.get_summary());
            assert_eq!(memory.get_class_histogram(), disk.get_class_histogram());
            assert_eq!(
                serde_json::to_value(memory.get_children(1024)).unwrap(),
                serde_json::to_value(disk.get_children(1024)).unwrap()
            );
            assert_eq!(disk.get_children(1024).unwrap().len(), 2);
        }
    }
}
