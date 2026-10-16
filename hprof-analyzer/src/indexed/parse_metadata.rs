//! Per-parse names, shallow aggregation and immutable candidate field readers.

use std::{collections::HashMap, sync::Arc};

use jvm_hprof::{
    heap_dump::{FieldType, PrimitiveArrayType},
    IdSize,
};

use super::node_store::{NodeStore, NodeType};
use crate::ClassHistogramEntry;

/// Resolve only class-name strings using top-level record headers. Heap payloads
/// are skipped, not parsed again. Keep field-string processing in source order
/// so this optimization does not silently change graph policy or the cache ABI.
pub(super) fn prepare_class_names(
    data: &[u8],
    entries: &mut Vec<(u64, u64)>,
    cancelled: impl Fn() -> bool,
) -> anyhow::Result<HashMap<u64, Arc<str>>> {
    let hprof = jvm_hprof::parse_hprof(data)
        .map_err(|e| anyhow::anyhow!("Invalid metadata header: {e:?}"))?;
    let mut names: HashMap<u64, Option<Arc<str>>> = HashMap::new();
    for record in hprof.records_iter() {
        anyhow::ensure!(!cancelled(), "Analysis cancelled");
        let record = record.map_err(|e| anyhow::anyhow!("Invalid metadata record: {e:?}"))?;
        if let Some(class) = record.as_load_class() {
            let class = class.map_err(|e| anyhow::anyhow!("Invalid metadata class: {e:?}"))?;
            let (id, name) = (class.class_obj_id().id(), class.class_name_id().id());
            entries.push((id, name));
            names.entry(name).or_insert(None);
        }
    }
    for record in hprof.records_iter() {
        anyhow::ensure!(!cancelled(), "Analysis cancelled");
        let record = record.map_err(|e| anyhow::anyhow!("Invalid metadata record: {e:?}"))?;
        if let Some(text) = record.as_utf_8() {
            let text = text.map_err(|e| anyhow::anyhow!("Invalid metadata string: {e:?}"))?;
            if let Some(name) = names.get_mut(&text.name_id().id()) {
                *name = Some(Arc::from(crate::graph_builder::convert_jvm_class_name(
                    &String::from_utf8_lossy(text.text()),
                )));
            }
        }
    }
    let mut result = HashMap::new();
    result.try_reserve(entries.len())?;
    for &(id, name) in entries.iter() {
        if let Some(Some(name)) = names.get(&name) {
            result.insert(id, name.clone());
        }
    }
    Ok(result)
}

pub(super) struct ParseNames {
    unknown: HashMap<u64, Arc<str>>,
    primitive: [Arc<str>; 8],
    object_array: Arc<str>,
}

impl ParseNames {
    pub(super) fn new() -> Self {
        Self {
            unknown: HashMap::new(),
            primitive: [
                "boolean[]",
                "byte[]",
                "char[]",
                "short[]",
                "int[]",
                "float[]",
                "long[]",
                "double[]",
            ]
            .map(Arc::from),
            object_array: Arc::from("Object[]"),
        }
    }

    pub(super) fn unknown(&mut self, class_id: u64) -> Arc<str> {
        self.unknown
            .entry(class_id)
            .or_insert_with(|| Arc::from(format!("Unknown(0x{class_id:x})")))
            .clone()
    }

    pub(super) fn object_array(&self) -> Arc<str> {
        self.object_array.clone()
    }

    pub(super) fn primitive(&self, kind: PrimitiveArrayType) -> (u32, Arc<str>) {
        let (width, slot) = match kind {
            PrimitiveArrayType::Boolean => (1, 0),
            PrimitiveArrayType::Byte => (1, 1),
            PrimitiveArrayType::Char => (2, 2),
            PrimitiveArrayType::Short => (2, 3),
            PrimitiveArrayType::Int => (4, 4),
            PrimitiveArrayType::Float => (4, 5),
            PrimitiveArrayType::Long => (8, 6),
            PrimitiveArrayType::Double => (8, 7),
        };
        (width, self.primitive[slot].clone())
    }
}

/// Display grouping remains by text, independently of class-object identity.
/// Numeric pointer keys only memoize names borrowed from the live node store;
/// no pointer is dereferenced and equal text from distinct owners still merges.
pub(super) fn shallow_histogram(nodes: &NodeStore) -> Vec<ClassHistogramEntry> {
    const MAX_IDENTITY_SLOTS: usize = 65_536;
    let mut identities = HashMap::new();
    let mut names = HashMap::new();
    let mut totals: Vec<(Arc<str>, u64, u64)> = Vec::new();
    for node in nodes.iter() {
        if !matches!(
            node.node_type,
            NodeType::Instance | NodeType::ObjectArray | NodeType::PrimitiveArray
        ) {
            continue;
        }
        let name = node.class_name.as_ref();
        let identity = (name.as_ptr() as usize, name.len());
        let slot = if let Some(&slot) = identities.get(&identity) {
            slot
        } else {
            let slot = *names.entry(node.class_name.clone()).or_insert_with(|| {
                let slot = totals.len();
                totals.push((node.class_name.clone(), 0, 0));
                slot
            });
            if identities.len() < MAX_IDENTITY_SLOTS {
                identities.insert(identity, slot);
            }
            slot
        };
        let total = &mut totals[slot];
        total.1 += 1;
        total.2 += node.shallow_size;
    }
    let mut result: Vec<_> = totals
        .into_iter()
        .map(|(name, count, size)| ClassHistogramEntry {
            class_name: name.to_string(),
            instance_count: count,
            shallow_size: size,
            retained_size: 0,
        })
        .collect();
    result.sort_by(|a, b| {
        b.shallow_size
            .cmp(&a.shallow_size)
            .then_with(|| a.class_name.cmp(&b.class_name))
    });
    result
}

/// The same first object/int fields selected by the existing Waste readers.
/// Plans are built for selected full class IDs, never matched by a truncated ID.
pub(super) struct CandidateFields {
    first_object: Option<usize>,
    first_int: Option<usize>,
    object_width: usize,
}

impl CandidateFields {
    pub(super) fn new(layout: &[(Arc<str>, FieldType)], id_size: IdSize) -> Self {
        let mut plan = Self {
            first_object: None,
            first_int: None,
            object_width: match id_size {
                IdSize::U32 => 4,
                IdSize::U64 => 8,
            },
        };
        let mut offset = 0usize;
        for (_, kind) in layout {
            match kind {
                FieldType::ObjectId if plan.first_object.is_none() => {
                    plan.first_object = Some(offset)
                }
                FieldType::Int if plan.first_int.is_none() => plan.first_int = Some(offset),
                _ => {}
            }
            let Some(end) =
                offset.checked_add(crate::graph_builder::field_type_size(kind, id_size))
            else {
                break;
            };
            offset = end;
        }
        plan
    }

    pub(super) fn object(&self, bytes: &[u8]) -> Option<u64> {
        let start = self.first_object?;
        let field = bytes.get(start..start.checked_add(self.object_width)?)?;
        Some(match self.object_width {
            4 => u32::from_be_bytes(field.try_into().ok()?) as u64,
            8 => u64::from_be_bytes(field.try_into().ok()?),
            _ => return None,
        })
    }

    pub(super) fn int(&self, bytes: &[u8]) -> Option<u64> {
        let start = self.first_int?;
        let field = bytes.get(start..start.checked_add(4)?)?;
        Some(u32::from_be_bytes(field.try_into().ok()?) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn class_headers_resolve_forward_strings_and_repeated_names_without_heap_scans() {
        fn record(data: &mut Vec<u8>, tag: u8, body: &[u8]) {
            data.push(tag);
            data.extend(0u32.to_be_bytes());
            data.extend((body.len() as u32).to_be_bytes());
            data.extend(body);
        }
        fn loaded(data: &mut Vec<u8>, class: u64, name: u64) {
            let mut body = Vec::new();
            body.extend(1u32.to_be_bytes());
            body.extend(class.to_be_bytes());
            body.extend(0u32.to_be_bytes());
            body.extend(name.to_be_bytes());
            record(data, 2, &body);
        }
        fn text(data: &mut Vec<u8>, id: u64, text: &[u8]) {
            let mut body = id.to_be_bytes().to_vec();
            body.extend(text);
            record(data, 1, &body);
        }
        let mut data = b"JAVA PROFILE 1.0.2\0".to_vec();
        data.extend(8u32.to_be_bytes());
        data.extend(0u64.to_be_bytes());
        loaded(&mut data, u64::MAX - 1, 10);
        loaded(&mut data, 42, 11);
        loaded(&mut data, 42, 10);
        text(&mut data, 10, b"old/Name");
        text(&mut data, 11, b"other/Name");
        text(&mut data, 10, b"final/Name");
        let mut entries = Vec::new();
        let names = prepare_class_names(&data, &mut entries, || false).unwrap();
        assert_eq!(entries, vec![(u64::MAX - 1, 10), (42, 11), (42, 10)]);
        assert_eq!(names[&(u64::MAX - 1)].as_ref(), "final.Name");
        assert_eq!(names[&42].as_ref(), "final.Name");
        assert!(Arc::ptr_eq(&names[&42], &names[&(u64::MAX - 1)]));
        assert!(prepare_class_names(&data, &mut Vec::new(), || true).is_err());
    }

    #[test]
    fn names_share_allocations_without_truncating_class_ids() {
        let mut pool = ParseNames::new();
        let low = pool.unknown(7);
        assert!(Arc::ptr_eq(&low, &pool.unknown(7)));
        let high = pool.unknown((1u64 << 40) + 7);
        assert_ne!(low, high);
        assert_eq!(high.as_ref(), "Unknown(0x10000000007)");
        assert!(Arc::ptr_eq(&pool.object_array(), &pool.object_array()));
        for kind in [
            PrimitiveArrayType::Boolean,
            PrimitiveArrayType::Byte,
            PrimitiveArrayType::Char,
            PrimitiveArrayType::Short,
            PrimitiveArrayType::Int,
            PrimitiveArrayType::Float,
            PrimitiveArrayType::Long,
            PrimitiveArrayType::Double,
        ] {
            let (width, name) = pool.primitive(kind);
            assert_eq!(name.as_ref(), format!("{}[]", kind.java_type_name()));
            assert!([1, 2, 4, 8].contains(&width));
            assert!(Arc::ptr_eq(&name, &pool.primitive(kind).1));
        }
    }

    #[test]
    fn histogram_merges_equal_text_but_not_different_labels() {
        let mut nodes = NodeStore::new();
        let shared: Arc<str> = Arc::from("pkg.Owner");
        nodes.add_node(0, 0, 0, NodeType::SuperRoot, shared.clone());
        nodes.add_node(1, 0, 8, NodeType::Class, shared.clone());
        nodes.add_node(2, 0, 16, NodeType::Instance, shared.clone());
        nodes.add_node(3, 0, 24, NodeType::Instance, shared);
        nodes.add_node(4, 0, 32, NodeType::Instance, Arc::from("pkg.Owner"));
        nodes.add_node(5, 0, 0, NodeType::PrimitiveArray, Arc::from("byte[]"));
        nodes.add_node(6, 0, 8, NodeType::ObjectArray, Arc::from("pkg.Owner[]"));
        let histogram = shallow_histogram(&nodes);
        assert_eq!(histogram.len(), 3);
        assert_eq!(histogram[0].class_name, "pkg.Owner");
        assert_eq!(histogram[0].instance_count, 3);
        assert_eq!(histogram[0].shallow_size, 72);
        assert_eq!(histogram[2].class_name, "byte[]");
        assert_eq!(histogram[2].instance_count, 1);
        assert!(histogram.iter().all(|entry| entry.retained_size == 0));
    }

    #[test]
    fn field_plans_match_existing_readers_at_every_truncated_length() {
        use FieldType::*;
        for id_size in [IdSize::U32, IdSize::U64] {
            for types in [
                vec![],
                vec![Byte, ObjectId, Int, ObjectId],
                vec![Long, Double, Char, Boolean, Short, Float, Int, ObjectId],
                vec![Int, Byte, ObjectId, Int],
                vec![Byte, Long],
            ] {
                let layout: Vec<_> = types
                    .iter()
                    .map(|kind| (Arc::from("field"), *kind))
                    .collect();
                let plan = CandidateFields::new(&layout, id_size);
                let data: Vec<_> = (0..96).map(|n| (n * 71 + 19) as u8).collect();
                for len in 0..=data.len() {
                    let data = &data[..len];
                    assert_eq!(
                        plan.object(data),
                        crate::waste::extract_nth_field_of_type(data, id_size, &types, ObjectId, 0)
                    );
                    assert_eq!(
                        plan.int(data),
                        crate::waste::extract_nth_field_of_type(data, id_size, &types, Int, 0)
                    );
                }
            }
        }
    }

    #[test]
    fn distinct_class_layouts_keep_distinct_field_offsets() {
        use FieldType::*;
        let ids = [7u64, (1u64 << 40) + 7];
        let plans: HashMap<_, _> = [
            (
                ids[0],
                CandidateFields::new(&[(Arc::from("value"), ObjectId)], IdSize::U64),
            ),
            (
                ids[1],
                CandidateFields::new(
                    &[(Arc::from("prefix"), Int), (Arc::from("value"), ObjectId)],
                    IdSize::U64,
                ),
            ),
        ]
        .into_iter()
        .collect();
        let data: Vec<_> = (0u8..12).collect();
        assert_eq!(plans[&ids[0]].object(&data), Some(0x0001020304050607));
        assert_eq!(plans[&ids[1]].object(&data), Some(0x0405060708090a0b));
    }
}
