//! Shallow allocation aggregation without an object index or reference graph.
//! Reuses the HPROF parser, root classification, and shared sizing policy.
use std::collections::{HashMap, HashSet};

use jvm_hprof::{heap_dump::SubRecord, parse_hprof, RecordTag};
use serde::Serialize;
use thiserror::Error;

use crate::{
    hprof_sizing::HprofSizing,
    object_layout::{ObjectLayout, SizeModel},
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ScanError {
    #[error("Quick scan cancelled")]
    Cancelled,
    #[error("Malformed or incomplete HPROF")]
    InvalidHeap,
    #[error("Quick scan supports conventional HPROF 1.0.1 and 1.0.2 captures")]
    Unsupported,
    #[error("Quick-scan metadata limit exceeded")]
    MetadataLimit,
    #[error("Quick-scan counter overflow")]
    Overflow,
}

/// Metadata/work limits, not a total resident-memory guarantee.
#[derive(Clone, Copy, Debug)]
pub struct ScanLimits {
    pub classes: usize,
    pub field_descriptors: usize,
    pub name_bytes: usize,
    pub total_name_bytes: usize,
}
impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            classes: 250_000,
            field_descriptors: 2_000_000,
            name_bytes: 65_536,
            total_name_bytes: 32 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ShallowSummary {
    pub total_heap_size: u64,
    /// Unavailable until a retaining graph is computed; never a shallow-size substitute.
    pub reachable_heap_size: Option<u64>,
    pub total_instances: u64,
    pub total_arrays: u64,
    /// Unique declared/loaded class IDs, not the full graph's class-node counter.
    pub declared_classes: u64,
    pub total_gc_roots: u64,
    pub unresolved_class_names: u64,
    pub hprof_version: String,
    pub heap_types: Vec<String>,
    pub size_model: SizeModel,
}

#[derive(Debug, Serialize)]
pub struct ShallowClassEntry {
    pub class_name: String,
    pub instance_count: u64,
    pub shallow_size: u64,
}

/// Does not implement HeapAnalysis: graph-dependent operations are unavailable,
/// rather than returning invented zero sizes or empty retaining paths.
#[derive(Debug, Serialize)]
pub struct ShallowScan {
    pub summary: ShallowSummary,
    pub class_histogram: Vec<ShallowClassEntry>,
}

#[derive(Hash, PartialEq, Eq)]
enum ClassKey {
    Instance(u64),
    Array(u64),
    Primitive(&'static str),
}

fn increment(value: &mut u64, amount: u64) -> Result<(), ScanError> {
    *value = value.checked_add(amount).ok_or(ScanError::Overflow)?;
    Ok(())
}
fn bounded(size: usize, limit: usize) -> Result<(), ScanError> {
    if size > limit {
        Err(ScanError::MetadataLimit)
    } else {
        Ok(())
    }
}

/// Scan completed immutable bytes. Counts concern allocation records; object-ID
/// uniqueness and reference validity are intentionally not indexed or checked.
pub fn scan_shallow(data: &[u8]) -> Result<ShallowScan, ScanError> {
    scan_shallow_with_options(data, None, ScanLimits::default())
}

struct Metadata {
    class_names: HashMap<u64, u64>,
    classes: HashSet<u64>,
    heap_names: HashSet<u64>,
}

fn collect_metadata(
    hprof: &jvm_hprof::Hprof<'_>,
    limits: ScanLimits,
    check: &dyn Fn() -> Result<(), ScanError>,
) -> Result<Metadata, ScanError> {
    let mut class_names = HashMap::new();
    let mut classes = HashSet::new();
    let mut heap_names = HashSet::new();
    let mut field_count = 0usize;
    let mut has_heap = false;
    let mut segmented = false;
    // Bound class metadata before asking the existing sizing policy to resolve it.
    for record in hprof.records_iter() {
        check()?;
        let record = record.map_err(|_| ScanError::InvalidHeap)?;
        match record.tag() {
            RecordTag::HeapDump => has_heap = true,
            RecordTag::HeapDumpSegment => {
                has_heap = true;
                segmented = true;
            }
            RecordTag::HeapDumpEnd => segmented = false,
            _ => {}
        }
        if let Some(load) = record.as_load_class() {
            let load = load.map_err(|_| ScanError::InvalidHeap)?;
            classes.insert(load.class_obj_id().id());
            class_names.insert(load.class_obj_id().id(), load.class_name_id().id());
            bounded(classes.len(), limits.classes)?;
        }
        if let Some(heap) = record.as_heap_dump_segment() {
            for item in heap.map_err(|_| ScanError::InvalidHeap)?.sub_records() {
                check()?;
                match item.map_err(|_| ScanError::InvalidHeap)? {
                    SubRecord::Class(class) => {
                        classes.insert(class.obj_id().id());
                        bounded(classes.len(), limits.classes)?;
                        for field in class.instance_field_descriptors() {
                            field.map_err(|_| ScanError::InvalidHeap)?;
                            field_count = field_count.checked_add(1).ok_or(ScanError::Overflow)?;
                            bounded(field_count, limits.field_descriptors)?;
                        }
                    }
                    SubRecord::HeapDumpInfo(info) => {
                        heap_names.insert(info.heap_name_id().id());
                        bounded(heap_names.len(), limits.classes)?;
                    }
                    SubRecord::PrimitiveArrayNoData(_) => return Err(ScanError::Unsupported),
                    _ => {}
                }
            }
        }
    }
    if !has_heap || segmented {
        return Err(ScanError::InvalidHeap);
    }

    Ok(Metadata {
        class_names,
        classes,
        heap_names,
    })
}

fn collect_names(
    hprof: &jvm_hprof::Hprof<'_>,
    metadata: &Metadata,
    limits: ScanLimits,
    check: &dyn Fn() -> Result<(), ScanError>,
) -> Result<HashMap<u64, String>, ScanError> {
    // Retain only requested metadata names, never heap string values or all UTF8 records.
    let wanted: HashSet<_> = metadata
        .class_names
        .values()
        .copied()
        .chain(metadata.heap_names.iter().copied())
        .collect();
    let mut names = HashMap::new();
    let mut name_bytes = 0usize;
    for record in hprof.records_iter() {
        check()?;
        let record = record.map_err(|_| ScanError::InvalidHeap)?;
        if let Some(text) = record.as_utf_8() {
            let text = text.map_err(|_| ScanError::InvalidHeap)?;
            if wanted.contains(&text.name_id().id()) {
                bounded(text.text().len(), limits.name_bytes)?;
                let name = String::from_utf8_lossy(text.text()).into_owned();
                bounded(name.len(), limits.name_bytes)?;
                // Count decoded bytes, including replacements in non-UTF8 metadata.
                name_bytes = name_bytes
                    .checked_add(name.len())
                    .ok_or(ScanError::Overflow)?;
                bounded(name_bytes, limits.total_name_bytes)?;
                names.insert(text.name_id().id(), name);
            }
        }
    }
    Ok(names)
}

/// Explicit layout and metadata limits are library policies, independent of hosts.
pub fn scan_shallow_with_options(
    data: &[u8],
    layout: Option<ObjectLayout>,
    limits: ScanLimits,
) -> Result<ShallowScan, ScanError> {
    scan_shallow_cancellable(data, layout, limits, &|| false)
}

/// Cooperative cancellation across every record pass, including layout metadata.
/// No retained graph is created, even when a caller cancels or retries this work.
pub fn scan_shallow_cancellable(
    data: &[u8],
    layout: Option<ObjectLayout>,
    limits: ScanLimits,
    cancelled: &dyn Fn() -> bool,
) -> Result<ShallowScan, ScanError> {
    let check = || {
        if cancelled() {
            Err(ScanError::Cancelled)
        } else {
            Ok(())
        }
    };
    check()?;
    let hprof = parse_hprof(data).map_err(|_| ScanError::InvalidHeap)?;
    let version = hprof.header().label().map_err(|_| ScanError::InvalidHeap)?;
    if !matches!(version, "JAVA PROFILE 1.0.1" | "JAVA PROFILE 1.0.2") {
        return Err(ScanError::Unsupported);
    }
    let metadata = collect_metadata(&hprof, limits, &check)?;
    let names = collect_names(&hprof, &metadata, limits, &check)?;
    let Metadata {
        class_names,
        classes,
        heap_names,
    } = metadata;
    let sizing = HprofSizing::read_cancellable(data, layout, cancelled).map_err(|_| {
        if cancelled() {
            ScanError::Cancelled
        } else {
            ScanError::InvalidHeap
        }
    })?;
    let mut summary = ShallowSummary {
        total_heap_size: 0,
        reachable_heap_size: None,
        total_instances: 0,
        total_arrays: 0,
        declared_classes: classes.len() as u64,
        total_gc_roots: 0,
        unresolved_class_names: 0,
        hprof_version: version.into(),
        heap_types: heap_names
            .iter()
            .filter_map(|id| names.get(id).cloned())
            .collect(),
        size_model: sizing.metadata.clone(),
    };
    summary.heap_types.sort();
    summary.heap_types.dedup();
    let mut histogram: HashMap<ClassKey, (u64, u64)> = HashMap::new();
    for record in hprof.records_iter() {
        check()?;
        let record = record.map_err(|_| ScanError::InvalidHeap)?;
        if let Some(heap) = record.as_heap_dump_segment() {
            for item in heap.map_err(|_| ScanError::InvalidHeap)?.sub_records() {
                check()?;
                let item = item.map_err(|_| ScanError::InvalidHeap)?;
                if crate::gc_roots::object_id(&item).is_some() {
                    increment(&mut summary.total_gc_roots, 1)?;
                    continue;
                }
                let (key, bytes) = match item {
                    SubRecord::Instance(instance) => {
                        increment(&mut summary.total_instances, 1)?;
                        (
                            ClassKey::Instance(instance.class_obj_id().id()),
                            sizing
                                .instance(instance.class_obj_id().id(), instance.fields().len())
                                .map_err(|_| ScanError::InvalidHeap)?,
                        )
                    }
                    SubRecord::ObjectArray(array) => {
                        increment(&mut summary.total_arrays, 1)?;
                        (
                            ClassKey::Array(array.array_class_obj_id().id()),
                            sizing
                                .object_array(array.num_elements())
                                .map_err(|_| ScanError::InvalidHeap)?,
                        )
                    }
                    SubRecord::PrimitiveArray(array) => {
                        increment(&mut summary.total_arrays, 1)?;
                        (
                            ClassKey::Primitive(array.primitive_type().java_type_name()),
                            sizing
                                .primitive_array(
                                    array.num_elements(),
                                    crate::hprof_sizing::primitive_bytes(array.primitive_type()),
                                )
                                .map_err(|_| ScanError::InvalidHeap)?,
                        )
                    }
                    _ => continue,
                };
                increment(&mut summary.total_heap_size, bytes)?;
                let totals = histogram.entry(key).or_default();
                increment(&mut totals.0, 1)?;
                increment(&mut totals.1, bytes)?;
                bounded(histogram.len(), limits.classes)?;
            }
        }
    }
    let mut merged: HashMap<String, (u64, u64)> = HashMap::new();
    for (key, (count, bytes)) in histogram {
        check()?;
        let name = match key {
            ClassKey::Primitive(name) => format!("{name}[]"),
            ClassKey::Instance(id) | ClassKey::Array(id) => {
                if let Some(name) = class_names.get(&id).and_then(|id| names.get(id)) {
                    crate::graph_builder::convert_jvm_class_name(name)
                } else {
                    increment(&mut summary.unresolved_class_names, 1)?;
                    match key {
                        ClassKey::Array(_) => "Object[]".into(),
                        _ => format!("Unknown(0x{id:x})"),
                    }
                }
            }
        };
        let totals = merged.entry(name).or_default();
        increment(&mut totals.0, count)?;
        increment(&mut totals.1, bytes)?;
    }
    let mut class_histogram: Vec<_> = merged
        .into_iter()
        .map(
            |(class_name, (instance_count, shallow_size))| ShallowClassEntry {
                class_name,
                instance_count,
                shallow_size,
            },
        )
        .collect();
    class_histogram.sort_by(|a, b| {
        b.shallow_size
            .cmp(&a.shallow_size)
            .then(a.class_name.cmp(&b.class_name))
    });
    check()?;
    Ok(ShallowScan {
        summary,
        class_histogram,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_observed_across_all_scan_passes() {
        use std::cell::Cell;
        let bytes = fixture(Some(8), 9);
        let calls = Cell::new(0);
        scan_shallow_cancellable(&bytes, None, ScanLimits::default(), &|| {
            calls.set(calls.get() + 1);
            false
        })
        .unwrap();
        let total = calls.get();
        assert!(total > 10);
        for stop in 1..=total {
            calls.set(0);
            let result = scan_shallow_cancellable(&bytes, None, ScanLimits::default(), &|| {
                calls.set(calls.get() + 1);
                calls.get() >= stop
            });
            assert_eq!(
                result.unwrap_err(),
                ScanError::Cancelled,
                "checkpoint {stop}"
            );
        }
    }

    fn record(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
        out.push(tag);
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(body);
    }
    fn fixture(kind: Option<u8>, length: u32) -> Vec<u8> {
        let mut out = b"JAVA PROFILE 1.0.2\0".to_vec();
        out.extend_from_slice(&4u32.to_be_bytes());
        out.extend_from_slice(&0u64.to_be_bytes());
        let mut heap = vec![0xff];
        heap.extend_from_slice(&512u32.to_be_bytes());
        heap.push(if kind.is_some() { 0x23 } else { 0x22 });
        heap.extend_from_slice(&512u32.to_be_bytes());
        heap.extend_from_slice(&0u32.to_be_bytes());
        heap.extend_from_slice(&length.to_be_bytes());
        let width = if let Some(kind) = kind {
            heap.push(kind);
            match kind {
                8 => 1,
                11 => 8,
                _ => unreachable!(),
            }
        } else {
            heap.extend_from_slice(&256u32.to_be_bytes());
            4
        };
        heap.resize(heap.len() + length as usize * width, 0x78);
        record(&mut out, 0x1c, &heap);
        record(&mut out, 0x2c, &[]);
        out
    }
    #[test]
    fn shallow_sizes_have_a_hand_counted_oracle_and_no_retained_field() {
        for (kind, count, expected) in [
            (Some(8), 0, 16),
            (Some(8), 9, 24),
            (Some(11), 3, 40),
            (None, 3, 24),
        ] {
            let scan = scan_shallow(&fixture(kind, count)).unwrap();
            assert_eq!(scan.summary.total_heap_size, expected);
            assert_eq!(scan.summary.total_arrays, 1);
            assert_eq!(scan.summary.total_gc_roots, 1);
            assert!(scan.summary.reachable_heap_size.is_none());
            let json = serde_json::to_value(&scan).unwrap();
            assert!(json["class_histogram"][0].get("retained_size").is_none());
            // Object-array values refer to absent objects; a shallow scan does not resolve them.
        }
    }
    #[test]
    fn late_class_names_are_resolved_without_retaining_unrelated_strings() {
        let mut data = fixture(None, 3);
        let mut name = 42u32.to_be_bytes().to_vec();
        name.extend_from_slice(b"[Ljava/lang/Object;");
        record(&mut data, 0x01, &name);
        let mut load = 1u32.to_be_bytes().to_vec();
        load.extend_from_slice(&256u32.to_be_bytes());
        load.extend_from_slice(&0u32.to_be_bytes());
        load.extend_from_slice(&42u32.to_be_bytes());
        record(&mut data, 0x02, &load);
        let mut unrelated = 43u32.to_be_bytes().to_vec();
        unrelated.extend_from_slice(b"PRIVATE_UNUSED_METADATA_CANARY");
        record(&mut data, 0x01, &unrelated);
        let scan = scan_shallow(&data).unwrap();
        assert_eq!(scan.class_histogram[0].class_name, "java.lang.Object[]");
        assert_eq!(scan.summary.unresolved_class_names, 0);
        assert!(!serde_json::to_string(&scan)
            .unwrap()
            .contains("PRIVATE_UNUSED_METADATA_CANARY"));
    }
    #[test]
    fn metadata_limits_fail_without_returning_partial_success() {
        let limits = ScanLimits {
            classes: 0,
            ..ScanLimits::default()
        };
        assert_eq!(
            scan_shallow_with_options(&fixture(Some(8), 9), None, limits).unwrap_err(),
            ScanError::MetadataLimit
        );
        let mut data = fixture(None, 3);
        let mut name = 42u32.to_be_bytes().to_vec();
        name.extend_from_slice(b"[Ljava/lang/Object;");
        record(&mut data, 0x01, &name);
        let mut load = 1u32.to_be_bytes().to_vec();
        load.extend_from_slice(&256u32.to_be_bytes());
        load.extend_from_slice(&0u32.to_be_bytes());
        load.extend_from_slice(&42u32.to_be_bytes());
        record(&mut data, 0x02, &load);
        for limits in [
            ScanLimits {
                name_bytes: 1,
                ..ScanLimits::default()
            },
            ScanLimits {
                total_name_bytes: 1,
                ..ScanLimits::default()
            },
        ] {
            assert_eq!(
                scan_shallow_with_options(&data, None, limits).unwrap_err(),
                ScanError::MetadataLimit
            );
        }
    }

    #[test]
    fn decoded_metadata_names_obey_the_per_name_limit() {
        let mut data = fixture(None, 3);
        let mut name = 42u32.to_be_bytes().to_vec();
        name.push(0xff); // One raw byte decodes to a three-byte replacement character.
        record(&mut data, 0x01, &name);
        let mut load = 1u32.to_be_bytes().to_vec();
        load.extend_from_slice(&256u32.to_be_bytes());
        load.extend_from_slice(&0u32.to_be_bytes());
        load.extend_from_slice(&42u32.to_be_bytes());
        record(&mut data, 0x02, &load);
        let limits = ScanLimits {
            name_bytes: 1,
            ..ScanLimits::default()
        };
        assert_eq!(
            scan_shallow_with_options(&data, None, limits).unwrap_err(),
            ScanError::MetadataLimit
        );
    }
    #[test]
    fn truncated_records_and_unfinished_segments_are_rejected() {
        let data = fixture(Some(8), 9);
        for length in [0, 17, 24, data.len() - 1, data.len() - 9] {
            assert_eq!(
                scan_shallow(&data[..length]).unwrap_err(),
                ScanError::InvalidHeap
            );
        }
    }
    #[test]
    fn android_sizing_is_not_silently_reinterpreted_as_hotspot() {
        let mut data = fixture(Some(8), 9);
        data[16] = b'3';
        assert_eq!(scan_shallow(&data).unwrap_err(), ScanError::Unsupported);
    }
    #[test]
    fn counter_overflow_is_not_wrapped_into_a_valid_size() {
        let mut value = u64::MAX;
        assert_eq!(increment(&mut value, 1), Err(ScanError::Overflow));
        assert_eq!(value, u64::MAX);
    }

    fn instance_fixture(class_root: bool) -> Vec<u8> {
        let mut data = b"JAVA PROFILE 1.0.2\0".to_vec();
        data.extend_from_slice(&4u32.to_be_bytes());
        data.extend_from_slice(&0u64.to_be_bytes());
        let mut heap = Vec::new();
        if class_root {
            heap.push(0x05);
            heap.extend_from_slice(&256u32.to_be_bytes());
        }
        heap.push(0x20);
        heap.extend_from_slice(&256u32.to_be_bytes());
        heap.extend_from_slice(&0u32.to_be_bytes());
        for _ in 0..6 {
            heap.extend_from_slice(&0u32.to_be_bytes());
        }
        heap.extend_from_slice(&1u32.to_be_bytes());
        heap.extend_from_slice(&0u16.to_be_bytes());
        heap.extend_from_slice(&0u16.to_be_bytes());
        heap.extend_from_slice(&1u16.to_be_bytes());
        heap.extend_from_slice(&66u32.to_be_bytes());
        heap.push(8); // One byte instance field: 8 B header + 1 B, rounded to 16 B.
        heap.push(0x21);
        heap.extend_from_slice(&512u32.to_be_bytes());
        heap.extend_from_slice(&0u32.to_be_bytes());
        heap.extend_from_slice(&256u32.to_be_bytes());
        heap.extend_from_slice(&1u32.to_be_bytes());
        heap.push(0x7f);
        record(&mut data, 0x1c, &heap);
        record(&mut data, 0x2c, &[]);
        data
    }

    #[test]
    fn instance_sizes_reuse_class_metadata_and_bound_field_descriptors() {
        let data = instance_fixture(false);
        let scan = scan_shallow(&data).unwrap();
        assert_eq!(scan.summary.total_heap_size, 16);
        assert_eq!(scan.summary.total_instances, 1);
        assert_eq!(scan.summary.declared_classes, 1);
        assert_eq!(scan.summary.size_model.incomplete_classes, 0);
        let limits = ScanLimits {
            field_descriptors: 0,
            ..ScanLimits::default()
        };
        assert_eq!(
            scan_shallow_with_options(&data, None, limits).unwrap_err(),
            ScanError::MetadataLimit
        );
    }

    #[test]
    fn class_roots_preserve_declared_classes_in_shallow_results() {
        let scan = scan_shallow(&instance_fixture(true)).unwrap();
        assert_eq!(scan.summary.declared_classes, 1);
        assert_eq!(scan.summary.total_gc_roots, 1);
        assert_eq!(scan.summary.total_instances, 1);
        assert_eq!(scan.summary.total_heap_size, 16);
    }

    #[test]
    fn repeated_ids_are_reported_as_records_not_an_invented_unique_object_count() {
        let mut data = fixture(Some(8), 9);
        // Header is 19 + 4 + 8 B; each top-level record has a 9 B prefix.
        let heap = data[40..data.len() - 9].to_vec();
        data.truncate(data.len() - 9);
        record(&mut data, 0x1c, &heap);
        record(&mut data, 0x2c, &[]);
        let scan = scan_shallow(&data).unwrap();
        assert_eq!(scan.summary.total_arrays, 2);
        assert_eq!(scan.summary.total_heap_size, 48);
        assert_eq!(scan.class_histogram[0].instance_count, 2);
    }
}
