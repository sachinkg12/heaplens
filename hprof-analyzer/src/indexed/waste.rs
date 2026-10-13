//! Deferred waste analysis for the indexed backend.
//!
//! Computes waste metrics (duplicate strings, empty collections, over-allocated
//! arrays, boxed primitives) from raw data collected during parsing.
//! Called on-demand rather than eagerly during analysis.

use crate::waste::{compute_waste_analysis, WasteAnalysis, WasteRawData};
use crate::waste::{hash_bytes, BackingArrayInfo};
use std::{collections::HashMap, sync::Arc};

/// Validated ranges into an owned mapping. Structural parsing records ranges
/// without reading their contents; only actual String backing arrays are read.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub(crate) struct ArrayContentRange {
    pub offset: usize,
    pub length: usize,
    pub shallow_size: u64,
    pub is_char: bool,
}

pub(crate) struct LazyStringContents {
    pub mapping: Arc<memmap2::Mmap>,
    pub arrays: HashMap<u64, ArrayContentRange>,
    #[cfg(test)]
    hashed_arrays: std::sync::atomic::AtomicUsize,
}

impl LazyStringContents {
    pub(crate) fn new(
        mapping: Arc<memmap2::Mmap>,
        arrays: HashMap<u64, ArrayContentRange>,
    ) -> Self {
        Self {
            mapping,
            arrays,
            #[cfg(test)]
            hashed_arrays: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

pub(crate) fn backing_array(data: &[u8], size: u64, is_char: bool) -> BackingArrayInfo {
    let preview = if is_char {
        data.chunks_exact(2)
            .take(120)
            .filter_map(|c| char::from_u32(u16::from_be_bytes([c[0], c[1]]) as u32))
            .collect()
    } else {
        String::from_utf8_lossy(&data[..data.len().min(120)]).into_owned()
    };
    BackingArrayInfo {
        content_hash: hash_bytes(data),
        size,
        preview,
    }
}

/// Computes waste analysis from raw data collected during indexed parsing.
///
/// This is a thin wrapper around `compute_waste_analysis` that provides
/// the entry point for the indexed backend's lazy waste computation.
pub fn compute_indexed_waste(raw: &WasteRawData, total_heap_size: u64) -> WasteAnalysis {
    let Some(contents) = &raw.lazy_contents else {
        return compute_waste_analysis(raw, total_heap_size);
    };
    let mut resolved = raw.clone();
    resolved.lazy_contents = None;
    // Repeated String instances can share one backing array. Hash it once.
    for string in &raw.string_instances {
        let id = string.value_array_id;
        if resolved.backing_arrays.contains_key(&id) {
            continue;
        }
        if let Some(range) = contents.arrays.get(&id) {
            // Ranges were checked against this same owned mapping at parse time.
            let data = &contents.mapping[range.offset..range.offset + range.length];
            #[cfg(test)]
            contents
                .hashed_arrays
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            resolved
                .backing_arrays
                .insert(id, backing_array(data, range.shallow_size, range.is_char));
        }
    }
    compute_waste_analysis(&resolved, total_heap_size)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::indexed::{HeapAnalysis, IndexedAnalysisState};

    fn record(data: &mut Vec<u8>, tag: u8, body: &[u8]) {
        data.push(tag);
        data.extend(0u32.to_be_bytes());
        data.extend((body.len() as u32).to_be_bytes());
        data.extend(body);
    }

    pub(crate) fn string_fixture() -> Vec<u8> {
        let mut data = b"JAVA PROFILE 1.0.2\0".to_vec();
        data.extend(8u32.to_be_bytes());
        data.extend(0u64.to_be_bytes());
        for (id, name) in [(1u64, "java/lang/String"), (2, "value")] {
            let mut body = id.to_be_bytes().to_vec();
            body.extend(name.as_bytes());
            record(&mut data, 1, &body);
        }
        let mut load = 1u32.to_be_bytes().to_vec();
        load.extend(100u64.to_be_bytes());
        load.extend(0u32.to_be_bytes());
        load.extend(1u64.to_be_bytes());
        record(&mut data, 2, &load);
        let mut heap = vec![0x20];
        heap.extend(100u64.to_be_bytes());
        heap.extend(0u32.to_be_bytes());
        heap.extend([0u8; 48]);
        heap.extend(8u32.to_be_bytes());
        heap.extend([0u8; 4]);
        heap.extend(1u16.to_be_bytes());
        heap.extend(2u64.to_be_bytes());
        heap.push(2);
        for (id, backing) in [
            (200u64, 300u64),
            (201, 301),
            (202, 300),
            (203, 302),
            (204, 303),
        ] {
            heap.push(0xff);
            heap.extend(id.to_be_bytes());
            heap.push(0x21);
            heap.extend(id.to_be_bytes());
            heap.extend(0u32.to_be_bytes());
            heap.extend(100u64.to_be_bytes());
            heap.extend(8u32.to_be_bytes());
            heap.extend(backing.to_be_bytes());
        }
        for (id, is_char, contents) in [
            (300u64, false, b"abc".to_vec()),
            (301, false, b"abc".to_vec()),
            (302, true, vec![0, 97, 0, 98, 0, 99]),
            (303, true, vec![0, 97, 0, 98, 0, 99]),
            (304, false, vec![7; 4 * 1024 * 1024]),
        ] {
            heap.push(0x23);
            heap.extend(id.to_be_bytes());
            heap.extend(0u32.to_be_bytes());
            heap.extend((contents.len() as u32 / if is_char { 2 } else { 1 }).to_be_bytes());
            heap.push(if is_char { 5 } else { 8 });
            heap.extend(contents);
        }
        record(&mut data, 0x1c, &heap);
        record(&mut data, 0x2c, &[]);
        data
    }

    #[test]
    fn mapped_structural_analysis_never_hashes_payloads_and_lazy_waste_matches_eager() {
        let bytes = string_fixture();
        let eager = IndexedAnalysisState::from_parse_result(
            crate::indexed::parse::parse_indexed(&bytes).unwrap(),
        )
        .unwrap();
        let mut mapping = memmap2::MmapMut::map_anon(bytes.len()).unwrap();
        mapping.copy_from_slice(&bytes);
        let mapping = Arc::new(mapping.make_read_only().unwrap());
        let (phase1, deferred) =
            crate::indexed::parse::parse_indexed_phase1_mapped(mapping.clone(), None).unwrap();
        assert!(phase1.waste_raw.backing_arrays.is_empty());
        let contents = phase1.waste_raw.lazy_contents.clone().unwrap();
        assert_eq!(contents.arrays.len(), 5);
        assert_eq!(
            contents
                .hashed_arrays
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
        let phase2 = crate::indexed::parse::parse_indexed_phase2(&phase1, deferred).unwrap();
        let lazy = Arc::new(IndexedAnalysisState::from_phases(phase1, phase2).unwrap());
        drop(mapping);
        assert!(lazy.cached_waste_analysis().is_none());
        assert_eq!(
            serde_json::to_value(lazy.get_summary()).unwrap(),
            serde_json::to_value(eager.get_summary()).unwrap()
        );
        assert_eq!(
            serde_json::to_value(lazy.get_class_histogram()).unwrap(),
            serde_json::to_value(eager.get_class_histogram()).unwrap()
        );
        assert_eq!(lazy.execute_query("SELECT object_id, shallow_size, retained_size FROM instances ORDER BY object_id").unwrap().rows,
            eager.execute_query("SELECT object_id, shallow_size, retained_size FROM instances ORDER BY object_id").unwrap().rows);
        assert_eq!(
            serde_json::to_value(lazy.gc_root_path(300, 10)).unwrap(),
            serde_json::to_value(eager.gc_root_path(300, 10)).unwrap()
        );
        assert_eq!(
            serde_json::to_value(lazy.inspect_object_bytes(&bytes, 200)).unwrap(),
            serde_json::to_value(eager.inspect_object_bytes(&bytes, 200)).unwrap()
        );
        assert!(lazy.cached_waste_analysis().is_none());
        assert_eq!(
            contents
                .hashed_arrays
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
        let expected = eager.get_waste_analysis();
        assert!(expected.duplicate_string_wasted_bytes > 0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let lazy = lazy.clone();
                scope.spawn(move || assert_eq!(lazy.get_waste_analysis(), expected));
            }
        });
        assert_eq!(
            contents
                .hashed_arrays
                .load(std::sync::atomic::Ordering::Relaxed),
            4,
            "one hash per String backing array, none for the unrelated 4 MiB buffer"
        );
        assert!(lazy.cached_waste_analysis().is_some());
        assert!(std::ptr::eq(
            lazy.get_waste_analysis(),
            lazy.get_waste_analysis()
        ));
    }

    #[test]
    fn duplicate_group_cutoff_has_deterministic_ties() {
        let mut raw = WasteRawData::new();
        for id in (0u64..60).rev() {
            raw.backing_arrays.insert(
                id,
                BackingArrayInfo {
                    content_hash: id,
                    size: 20,
                    preview: format!("group-{id:02}"),
                },
            );
            for _ in 0..2 {
                raw.string_instances.push(crate::waste::StringInstanceInfo {
                    value_array_id: id,
                    shallow_size: 20,
                });
            }
        }
        for _ in 0..3 {
            let result = compute_indexed_waste(&raw, 100_000);
            assert_eq!(result.duplicate_string_wasted_bytes, 2000);
            assert_eq!(
                result
                    .duplicate_strings
                    .iter()
                    .map(|v| v.preview.clone())
                    .collect::<Vec<_>>(),
                (0..50)
                    .map(|id| format!("group-{id:02}"))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn empty_waste_data() {
        let raw = WasteRawData::new();
        let result = compute_indexed_waste(&raw, 1_000_000);

        assert_eq!(result.total_wasted_bytes, 0);
        assert_eq!(result.waste_percentage, 0.0);
        assert!(result.duplicate_strings.is_empty());
        assert!(result.empty_collections.is_empty());
        assert!(result.over_allocated_collections.is_empty());
        assert!(result.boxed_primitives.is_empty());
    }

    #[test]
    fn zero_heap_size() {
        let raw = WasteRawData::new();
        let result = compute_indexed_waste(&raw, 0);
        assert_eq!(result.waste_percentage, 0.0);
    }

    #[test]
    fn delegates_to_compute_waste_analysis() {
        // Verify that the function produces the same result as calling
        // compute_waste_analysis directly.
        let raw = WasteRawData::new();
        let direct = compute_waste_analysis(&raw, 100_000);
        let via_indexed = compute_indexed_waste(&raw, 100_000);

        assert_eq!(direct.total_wasted_bytes, via_indexed.total_wasted_bytes);
        assert_eq!(direct.waste_percentage, via_indexed.waste_percentage);
        assert_eq!(
            direct.duplicate_string_wasted_bytes,
            via_indexed.duplicate_string_wasted_bytes
        );
        assert_eq!(
            direct.empty_collection_wasted_bytes,
            via_indexed.empty_collection_wasted_bytes
        );
    }
}
