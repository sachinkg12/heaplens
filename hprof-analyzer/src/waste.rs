//! Waste analysis: duplicate strings, empty collections, over-allocated arrays, boxed primitives.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Info about a java.lang.String instance collected during Pass 2.
pub(crate) struct StringInstanceInfo {
    pub value_array_id: u64,
    pub shallow_size: u32,
}

/// Info about a backing array (byte[] or char[]) for string dedup.
pub(crate) struct BackingArrayInfo {
    pub content_hash: u64,
    pub size: u32,
    pub preview: String,
}

/// Info about an empty collection instance.
pub(crate) struct EmptyCollectionInfo {
    pub class_name: String,
    pub shallow_size: u32,
}

/// Info about an over-allocated collection instance.
pub(crate) struct OverAllocatedCollectionInfo {
    pub class_name: String,
    pub size: u32,
    pub capacity: u32,
}

/// Info about a boxed primitive instance.
pub(crate) struct BoxedPrimitiveInfo {
    pub class_name: String,
    pub shallow_size: u32,
}

/// Raw waste data collected during graph building.
pub struct WasteRawData {
    pub(crate) string_instances: Vec<StringInstanceInfo>,
    pub(crate) backing_arrays: HashMap<u64, BackingArrayInfo>,
    pub(crate) empty_collections: Vec<EmptyCollectionInfo>,
    pub(crate) array_element_counts: HashMap<u64, u32>,
    pub(crate) over_allocated_collections: Vec<OverAllocatedCollectionInfo>,
    pub(crate) boxed_primitives: Vec<BoxedPrimitiveInfo>,
}

impl WasteRawData {
    pub fn new() -> Self {
        WasteRawData {
            string_instances: Vec::new(),
            backing_arrays: HashMap::new(),
            empty_collections: Vec::new(),
            array_element_counts: HashMap::new(),
            over_allocated_collections: Vec::new(),
            boxed_primitives: Vec::new(),
        }
    }
}

/// Hashes a byte slice using SipHash (stdlib DefaultHasher).
pub fn hash_bytes(data: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

/// A group of duplicate strings sharing the same content.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DuplicateStringGroup {
    /// First 120 chars of the string content.
    pub preview: String,
    /// Number of copies of this string.
    pub count: u64,
    /// Bytes wasted by duplicates: (count - 1) * per_copy_size.
    pub wasted_bytes: u64,
    /// Total bytes used by all copies.
    pub total_bytes: u64,
}

/// A group of empty collection instances of the same class.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EmptyCollectionGroup {
    /// The collection class name (e.g. "java.util.HashMap").
    pub class_name: String,
    /// Number of empty instances.
    pub count: u64,
    /// Total shallow size of all empty instances.
    pub wasted_bytes: u64,
}

/// A group of over-allocated collection instances of the same class.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct OverAllocatedGroup {
    /// The collection class name.
    pub class_name: String,
    /// Number of over-allocated instances.
    pub count: u64,
    /// Total bytes wasted by excess capacity.
    pub wasted_bytes: u64,
    /// Average fill ratio (size / capacity) as percentage.
    pub avg_fill_ratio: f64,
}

/// A group of boxed primitive instances of the same class.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct BoxedPrimitiveGroup {
    /// The boxed primitive class name (e.g. "java.lang.Integer").
    pub class_name: String,
    /// Number of boxed instances.
    pub count: u64,
    /// Bytes wasted vs unboxed: count * (shallow_size - primitive_size).
    pub wasted_bytes: u64,
    /// Size if all were unboxed primitives.
    pub unboxed_size: u64,
}

/// Waste analysis results: duplicate strings, empty collections, over-allocated collections, boxed primitives.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WasteAnalysis {
    /// Total bytes wasted by all waste categories.
    pub total_wasted_bytes: u64,
    /// Waste as percentage of total heap.
    pub waste_percentage: f64,
    /// Bytes wasted by duplicate strings alone.
    pub duplicate_string_wasted_bytes: u64,
    /// Bytes wasted by empty collections alone.
    pub empty_collection_wasted_bytes: u64,
    /// Bytes wasted by over-allocated collections alone.
    pub over_allocated_wasted_bytes: u64,
    /// Bytes wasted by boxed primitives alone.
    pub boxed_primitive_wasted_bytes: u64,
    /// Top 50 duplicate string groups by wasted bytes.
    pub duplicate_strings: Vec<DuplicateStringGroup>,
    /// Empty collection groups by class.
    pub empty_collections: Vec<EmptyCollectionGroup>,
    /// Over-allocated collection groups by class.
    pub over_allocated_collections: Vec<OverAllocatedGroup>,
    /// Boxed primitive groups by class.
    pub boxed_primitives: Vec<BoxedPrimitiveGroup>,
}

/// Extracts the value of the Nth field matching a target type from instance field data.
///
/// Walks through the field layout and returns the raw bytes as u64 for the Nth
/// field of the specified type. Returns None if not enough fields of that type exist.
pub(crate) fn extract_nth_field_of_type(
    data: &[u8],
    id_size: jvm_hprof::IdSize,
    field_types: &[jvm_hprof::heap_dump::FieldType],
    target_type: jvm_hprof::heap_dump::FieldType,
    n: usize,
) -> Option<u64> {
    use jvm_hprof::heap_dump::FieldType;
    let mut offset = 0;
    let mut match_count = 0;

    let matches_target = |ft: &FieldType| -> bool {
        matches!(
            (&target_type, ft),
            (FieldType::ObjectId, FieldType::ObjectId)
            | (FieldType::Boolean, FieldType::Boolean)
            | (FieldType::Byte, FieldType::Byte)
            | (FieldType::Char, FieldType::Char)
            | (FieldType::Short, FieldType::Short)
            | (FieldType::Int, FieldType::Int)
            | (FieldType::Float, FieldType::Float)
            | (FieldType::Long, FieldType::Long)
            | (FieldType::Double, FieldType::Double)
        )
    };

    for ft in field_types {
        let size = crate::field_type_size(ft, id_size);
        if offset + size > data.len() {
            break;
        }
        if matches_target(ft) {
            if match_count == n {
                let value = match size {
                    1 => data[offset] as u64,
                    2 => u16::from_be_bytes([data[offset], data[offset + 1]]) as u64,
                    4 => u32::from_be_bytes([
                        data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                    ]) as u64,
                    8 => u64::from_be_bytes([
                        data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                        data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
                    ]),
                    _ => return None,
                };
                return Some(value);
            }
            match_count += 1;
        }
        offset += size;
    }
    None
}

/// Computes waste analysis from raw data collected during graph building.
pub fn compute_waste_analysis(
    waste_data: &WasteRawData,
    total_heap_size: u64,
) -> WasteAnalysis {
    // --- Duplicate strings ---
    let mut string_groups: HashMap<u64, (u64, u64, String)> = HashMap::new();
    for si in &waste_data.string_instances {
        if let Some(array_info) = waste_data.backing_arrays.get(&si.value_array_id) {
            let per_copy_size = si.shallow_size as u64 + array_info.size as u64;
            let entry = string_groups.entry(array_info.content_hash)
                .or_insert((0, per_copy_size, array_info.preview.clone()));
            entry.0 += 1;
        }
    }

    let mut dup_groups: Vec<DuplicateStringGroup> = string_groups
        .into_values()
        .filter(|(count, _, _)| *count > 1)
        .map(|(count, per_copy_size, preview)| {
            let wasted = (count - 1) * per_copy_size;
            let total = count * per_copy_size;
            DuplicateStringGroup { preview, count, wasted_bytes: wasted, total_bytes: total }
        })
        .collect();
    dup_groups.sort_by(|a, b| b.wasted_bytes.cmp(&a.wasted_bytes));
    dup_groups.truncate(50);

    let duplicate_string_wasted_bytes: u64 = dup_groups.iter().map(|g| g.wasted_bytes).sum();

    // --- Empty collections ---
    let mut collection_groups: HashMap<String, (u64, u64)> = HashMap::new();
    for ec in &waste_data.empty_collections {
        let entry = collection_groups.entry(ec.class_name.clone()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += ec.shallow_size as u64;
    }

    let mut empty_cols: Vec<EmptyCollectionGroup> = collection_groups
        .into_iter()
        .map(|(class_name, (count, wasted_bytes))| {
            EmptyCollectionGroup { class_name, count, wasted_bytes }
        })
        .collect();
    empty_cols.sort_by(|a, b| b.wasted_bytes.cmp(&a.wasted_bytes));

    let empty_collection_wasted_bytes: u64 = empty_cols.iter().map(|g| g.wasted_bytes).sum();

    // --- Over-allocated collections ---
    let ref_size = 8u64;
    let mut overalloc_groups: HashMap<String, (u64, u64, f64)> = HashMap::new();
    for oa in &waste_data.over_allocated_collections {
        let wasted = (oa.capacity as u64 - oa.size as u64) * ref_size;
        let fill_ratio = if oa.capacity > 0 { oa.size as f64 / oa.capacity as f64 } else { 0.0 };
        let entry = overalloc_groups.entry(oa.class_name.clone()).or_insert((0, 0, 0.0));
        entry.0 += 1;
        entry.1 += wasted;
        entry.2 += fill_ratio;
    }

    let mut over_allocated_cols: Vec<OverAllocatedGroup> = overalloc_groups
        .into_iter()
        .map(|(class_name, (count, wasted_bytes, sum_fill))| {
            let avg_fill_ratio = if count > 0 { (sum_fill / count as f64) * 100.0 } else { 0.0 };
            OverAllocatedGroup { class_name, count, wasted_bytes, avg_fill_ratio }
        })
        .collect();
    over_allocated_cols.sort_by(|a, b| b.wasted_bytes.cmp(&a.wasted_bytes));

    let over_allocated_wasted_bytes: u64 = over_allocated_cols.iter().map(|g| g.wasted_bytes).sum();

    // --- Boxed primitives ---
    let boxed_prim_sizes: HashMap<&str, u32> = [
        ("java.lang.Boolean", 1), ("java.lang.Byte", 1),
        ("java.lang.Character", 2), ("java.lang.Short", 2),
        ("java.lang.Integer", 4), ("java.lang.Float", 4),
        ("java.lang.Long", 8), ("java.lang.Double", 8),
    ].into_iter().collect();

    let mut boxed_groups: HashMap<String, (u64, u64)> = HashMap::new();
    for bp in &waste_data.boxed_primitives {
        let entry = boxed_groups.entry(bp.class_name.clone()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += bp.shallow_size as u64;
    }

    let mut boxed_prim_cols: Vec<BoxedPrimitiveGroup> = boxed_groups
        .into_iter()
        .map(|(class_name, (count, total_shallow))| {
            let prim_size = boxed_prim_sizes.get(class_name.as_str()).copied().unwrap_or(4) as u64;
            let unboxed_size = count * prim_size;
            let wasted_bytes = if total_shallow > unboxed_size { total_shallow - unboxed_size } else { 0 };
            BoxedPrimitiveGroup { class_name, count, wasted_bytes, unboxed_size }
        })
        .collect();
    boxed_prim_cols.sort_by(|a, b| b.wasted_bytes.cmp(&a.wasted_bytes));

    let boxed_primitive_wasted_bytes: u64 = boxed_prim_cols.iter().map(|g| g.wasted_bytes).sum();

    let total_wasted_bytes = duplicate_string_wasted_bytes + empty_collection_wasted_bytes
        + over_allocated_wasted_bytes + boxed_primitive_wasted_bytes;
    let waste_percentage = if total_heap_size > 0 {
        (total_wasted_bytes as f64 / total_heap_size as f64) * 100.0
    } else {
        0.0
    };

    log::info!(
        "Waste analysis: {:.2} MB wasted ({:.1}% of heap) — dup strings: {:.2} MB, empty collections: {:.2} MB, over-alloc: {:.2} MB, boxed prims: {:.2} MB",
        total_wasted_bytes as f64 / (1024.0 * 1024.0),
        waste_percentage,
        duplicate_string_wasted_bytes as f64 / (1024.0 * 1024.0),
        empty_collection_wasted_bytes as f64 / (1024.0 * 1024.0),
        over_allocated_wasted_bytes as f64 / (1024.0 * 1024.0),
        boxed_primitive_wasted_bytes as f64 / (1024.0 * 1024.0),
    );

    WasteAnalysis {
        total_wasted_bytes,
        waste_percentage,
        duplicate_string_wasted_bytes,
        empty_collection_wasted_bytes,
        over_allocated_wasted_bytes,
        boxed_primitive_wasted_bytes,
        duplicate_strings: dup_groups,
        empty_collections: empty_cols,
        over_allocated_collections: over_allocated_cols,
        boxed_primitives: boxed_prim_cols,
    }
}
