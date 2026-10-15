//! HPROF metadata adapter for the shared object-layout policy.
//! One zero-copy metadata scan; no per-object size map or field-body copies.
use crate::object_layout::ObjectLayout;
use anyhow::{bail, Result};
use jvm_hprof::heap_dump::{FieldType, SubRecord};
use jvm_hprof::{parse_hprof, IdSize, RecordTag};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct ClassShape {
    parent: Option<u64>,
    primitive_bytes: u64,
    references: u64,
}

/// Evidence only rules out layouts whose arrays would overlap another object.
/// Feasible layouts remain estimates; absence of compression evidence does not
/// prove the producer used uncompressed pointers. Keeps constant-size state.
struct LayoutEvidence {
    candidates: Vec<ObjectLayout>,
    possible: Vec<bool>,
    previous_array: Option<(u64, u32, Option<u64>)>,
    anchor: Option<u64>,
    alignment: u64,
    address_count: usize,
}
impl LayoutEvidence {
    fn new(id_bytes: u64) -> Self {
        let widths = if id_bytes == 8 { vec![8, 4] } else { vec![4] };
        let candidates: Vec<_> = widths
            .iter()
            .flat_map(|&r| {
                widths
                    .iter()
                    .map(move |&k| ObjectLayout::new(id_bytes, r, k, 8).unwrap())
            })
            .collect();
        Self {
            possible: vec![true; candidates.len()],
            candidates,
            previous_array: None,
            anchor: None,
            alignment: 256,
            address_count: 0,
        }
    }
    fn observe(&mut self, address: u64, array: Option<(u32, Option<u64>)>) -> Result<()> {
        if address == 0 {
            return Ok(());
        }
        self.address_count += 1;
        if let Some(anchor) = self.anchor {
            let delta = address.abs_diff(anchor);
            if delta != 0 {
                self.alignment = self.alignment.min(1u64 << delta.trailing_zeros().min(8));
            }
        } else {
            self.anchor = Some(address);
        }
        if let Some((start, length, width)) = self.previous_array {
            if address > start {
                let gap = address - start;
                let mut fits = [false; 4];
                for (index, layout) in self.candidates.iter().enumerate() {
                    fits[index] = match width {
                        Some(w) => layout.primitive_array(length, w),
                        None => layout.object_array(length),
                    }? <= gap;
                }
                // Ignore contradictory/non-address-like evidence rather than
                // manufacture a compressed layout from a malformed interval.
                if fits
                    .iter()
                    .zip(&self.possible)
                    .any(|(fit, possible)| *fit && *possible)
                {
                    for (possible, fit) in self.possible.iter_mut().zip(fits) {
                        *possible &= fit;
                    }
                }
            }
        }
        self.previous_array = array.map(|(length, width)| (address, length, width));
        Ok(())
    }
    fn finish(&self) -> ObjectLayout {
        let mut layout = self.candidates[self.possible.iter().position(|p| *p).unwrap_or(0)];
        // Sparse or synthetic dumps do not establish a larger allocation unit.
        layout.alignment = if self.address_count >= 32 {
            self.alignment.clamp(8, 256)
        } else {
            8
        };
        layout
    }
}

/// Validated record counts from the existing sizing scan, not file-size guesses.
/// Counts are reservation hints: duplicate objects/roots can share one node.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RecordCounts {
    pub strings: usize,
    pub load_classes: usize,
    pub classes: usize,
    pub instances: usize,
    pub object_arrays: usize,
    pub primitive_arrays: usize,
    pub roots: usize,
}
impl RecordCounts {
    fn increment(count: &mut usize) -> Result<()> {
        *count = count.checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("HPROF record count overflow"))?;
        Ok(())
    }
    pub fn node_capacity(&self) -> Result<usize> {
        [self.classes, self.instances, self.object_arrays, self.primitive_arrays, self.roots]
            .into_iter().try_fold(1usize, |sum, count| {
                sum.checked_add(count).ok_or_else(|| anyhow::anyhow!("HPROF node capacity overflow"))
            })
    }
    fn observe(&mut self, record: &SubRecord<'_>) -> Result<()> {
        if crate::gc_roots::object_id(record).is_some() {
            return Self::increment(&mut self.roots);
        }
        match record {
            SubRecord::Class(_) => Self::increment(&mut self.classes),
            SubRecord::Instance(_) => Self::increment(&mut self.instances),
            SubRecord::ObjectArray(_) => Self::increment(&mut self.object_arrays),
            SubRecord::PrimitiveArray(_) | SubRecord::PrimitiveArrayNoData(_) => Self::increment(&mut self.primitive_arrays),
            _ => Ok(()),
        }
    }
}

pub(crate) struct HprofSizing {
    pub layout: ObjectLayout,
    pub class_sizes: HashMap<u64, u64>,
    pub metadata: crate::object_layout::SizeModel,
    pub record_counts: RecordCounts,
    payload_only: bool,
}
impl HprofSizing {
    pub fn read(data: &[u8], explicit: Option<ObjectLayout>) -> Result<Self> {
        Self::read_cancellable(data, explicit, &|| false)
    }
    pub fn read_cancellable(
        data: &[u8],
        explicit: Option<ObjectLayout>,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Self> {
        if cancelled() {
            bail!("Sizing cancelled");
        }
        let hprof =
            parse_hprof(data).map_err(|e| anyhow::anyhow!("Invalid sizing header: {e:?}"))?;
        let id_bytes = if matches!(hprof.header().id_size(), IdSize::U32) {
            4
        } else {
            8
        };
        let mut evidence = LayoutEvidence::new(id_bytes);
        let mut classes = HashMap::new();
        // Android sizing is parked separately. Do not apply a HotSpot object
        // layout to ART dumps; retain their existing payload-only estimates.
        let payload_only =
            hprof.header().label().ok() == Some("JAVA PROFILE 1.0.3") && explicit.is_none();
        let mut declared_sizes = HashMap::new();
        let mut record_counts = RecordCounts::default();
        for record in hprof.records_iter() {
            if cancelled() {
                bail!("Sizing cancelled");
            }
            let record = record.map_err(|e| anyhow::anyhow!("Invalid sizing record: {e:?}"))?;
            match record.tag() {
                RecordTag::Utf8 => RecordCounts::increment(&mut record_counts.strings)?,
                RecordTag::LoadClass => RecordCounts::increment(&mut record_counts.load_classes)?,
                _ => {},
            }
            if let Some(heap) = record.as_heap_dump_segment() {
                for sub in heap
                    .map_err(|e| anyhow::anyhow!("Invalid sizing segment: {e:?}"))?
                    .sub_records()
                {
                    if cancelled() {
                        bail!("Sizing cancelled");
                    }
                    let sub = sub.map_err(|e| anyhow::anyhow!("Invalid sizing object: {e:?}"))?;
                    record_counts.observe(&sub)?;
                    match sub {
                        SubRecord::Class(class) => {
                            if payload_only {
                                declared_sizes.insert(
                                    class.obj_id().id(),
                                    u64::from(class.instance_size_bytes()),
                                );
                            }
                            let mut shape = ClassShape {
                                parent: class
                                    .super_class_obj_id()
                                    .map(|id| id.id())
                                    .filter(|id| *id != 0),
                                ..ClassShape::default()
                            };
                            for field in class.instance_field_descriptors() {
                                let field = field
                                    .map_err(|e| anyhow::anyhow!("Invalid sizing field: {e:?}"))?;
                                if matches!(field.field_type(), FieldType::ObjectId) {
                                    shape.references += 1;
                                } else {
                                    shape.primitive_bytes += field_bytes(field.field_type());
                                }
                            }
                            classes.insert(class.obj_id().id(), shape);
                            evidence.observe(class.obj_id().id(), None)?;
                        }
                        SubRecord::Instance(o) => evidence.observe(o.obj_id().id(), None)?,
                        SubRecord::ObjectArray(a) => {
                            evidence.observe(a.obj_id().id(), Some((a.num_elements(), None)))?
                        }
                        SubRecord::PrimitiveArray(a) => evidence.observe(
                            a.obj_id().id(),
                            Some((a.num_elements(), Some(primitive_bytes(a.primitive_type())))),
                        )?,
                        _ => {}
                    }
                }
            }
        }
        let layout = if payload_only {
            ObjectLayout::new(id_bytes, id_bytes, id_bytes, 8)?
        } else {
            explicit.unwrap_or_else(|| evidence.finish())
        };
        let class_sizes = if payload_only {
            declared_sizes
        } else {
            resolve_classes_cancellable(&classes, layout, cancelled)?
        };
        if payload_only {
            log::info!("Shallow sizes: legacy Android payload-only estimate; headers and alignment excluded.");
        } else {
            log::info!("Shallow sizes: estimated conventional JVM layout; word={} reference={} class_pointer={} alignment={} bytes; {}. Class metadata/hidden fields excluded.",
            layout.word_bytes,layout.reference_bytes,layout.class_pointer_bytes,layout.alignment,
            if explicit.is_some() {"explicit widths"} else {"inferred widths, ambiguous layouts use larger feasible widths"});
        }
        let metadata = crate::object_layout::SizeModel {
            name: if payload_only {
                "legacy-payload-v0"
            } else {
                "conventional-jvm-v1"
            },
            estimated: true,
            layout,
            layout_source: if payload_only {
                "legacy-payload"
            } else if explicit.is_some() {
                "explicit"
            } else {
                "address-inference-with-defaults"
            },
            incomplete_classes: classes.len() - class_sizes.len(),
            retained_size_policy: Some(crate::reference_strength::RETAINED_SIZE_POLICY.into()),
        };
        Ok(Self {
            layout,
            class_sizes,
            metadata,
            record_counts,
            payload_only,
        })
    }
    pub fn instance(&self, class_id: u64, serialized_bytes: usize) -> Result<u64> {
        self.class_sizes
            .get(&class_id)
            .copied()
            .map(Ok)
            .unwrap_or_else(|| {
                if self.payload_only {
                    Ok(serialized_bytes as u64)
                } else {
                    self.layout.fallback_instance(serialized_bytes)
                }
            })
    }
    pub fn object_array(&self, length: u32) -> Result<u64> {
        if self.payload_only {
            Ok(u64::from(length) * self.layout.word_bytes)
        } else {
            self.layout.object_array(length)
        }
    }
    pub fn primitive_array(&self, length: u32, width: u64) -> Result<u64> {
        if self.payload_only {
            Ok(u64::from(length) * width)
        } else {
            self.layout.primitive_array(length, width)
        }
    }
}

#[cfg(test)]
fn resolve_classes(
    classes: &HashMap<u64, ClassShape>,
    layout: ObjectLayout,
) -> Result<HashMap<u64, u64>> {
    resolve_classes_cancellable(classes, layout, &|| false)
}
fn resolve_classes_cancellable(
    classes: &HashMap<u64, ClassShape>,
    layout: ObjectLayout,
    cancelled: &dyn Fn() -> bool,
) -> Result<HashMap<u64, u64>> {
    let mut extents: HashMap<u64, Option<u64>> = HashMap::new();
    for &start in classes.keys() {
        if cancelled() {
            bail!("Sizing cancelled");
        }
        if extents.contains_key(&start) {
            continue;
        }
        let mut chain = Vec::new();
        let mut visited = HashSet::new();
        let mut current = Some(start);
        let mut extent = Some(layout.object_header());
        while let Some(id) = current {
            if cancelled() {
                bail!("Sizing cancelled");
            }
            if let Some(cached) = extents.get(&id) {
                extent = *cached;
                break;
            }
            if !visited.insert(id) {
                bail!("Cyclic superclass metadata at 0x{id:x}");
            }
            let Some(shape) = classes.get(&id) else {
                extent = None;
                break;
            };
            chain.push(id);
            current = shape.parent;
        }
        for id in chain.into_iter().rev() {
            let shape = &classes[&id];
            extent = extent
                .map(|parent| {
                    layout.extend_instance(parent, shape.primitive_bytes, shape.references)
                })
                .transpose()?;
            extents.insert(id, extent);
        }
    }
    extents
        .into_iter()
        .filter_map(|(id, extent)| extent.map(|e| layout.finish_instance(e).map(|size| (id, size))))
        .collect()
}

fn field_bytes(kind: FieldType) -> u64 {
    match kind {
        FieldType::Boolean | FieldType::Byte => 1,
        FieldType::Char | FieldType::Short => 2,
        FieldType::Int | FieldType::Float => 4,
        FieldType::Long | FieldType::Double => 8,
        FieldType::ObjectId => unreachable!("references have a separate width"),
    }
}
pub(crate) fn primitive_bytes(kind: jvm_hprof::heap_dump::PrimitiveArrayType) -> u64 {
    use jvm_hprof::heap_dump::PrimitiveArrayType::*;
    match kind {
        Boolean | Byte => 1,
        Char | Short => 2,
        Int | Float => 4,
        Long | Double => 8,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn record(data: &mut Vec<u8>, tag: u8, body: &[u8]) {
        data.push(tag);
        data.extend(0u32.to_be_bytes());
        data.extend((body.len() as u32).to_be_bytes());
        data.extend(body);
    }

    pub(crate) fn count_fixture_32(payload: u32) -> Vec<u8> {
        let mut data = b"JAVA PROFILE 1.0.3\0".to_vec();
        data.extend(4u32.to_be_bytes()); data.extend(0u64.to_be_bytes());
        let mut name = 1u32.to_be_bytes().to_vec(); name.extend(b"Example");
        record(&mut data, 1, &name);
        let mut load = 1u32.to_be_bytes().to_vec(); load.extend(10u32.to_be_bytes());
        load.extend(0u32.to_be_bytes()); load.extend(1u32.to_be_bytes());
        record(&mut data, 2, &load);
        let mut heap = Vec::new();
        // Repeated roots reserve conservatively but still describe one node.
        for _ in 0..2 { heap.push(0xff); heap.extend(20u32.to_be_bytes()); }
        // A newly attached JNI thread may have no object ID.
        heap.push(0x08); heap.extend(0u32.to_be_bytes()); heap.extend(1u32.to_be_bytes()); heap.extend(0u32.to_be_bytes());
        heap.push(0x20); heap.extend(10u32.to_be_bytes()); heap.extend(0u32.to_be_bytes());
        heap.extend([0u8; 24]); heap.extend(0u32.to_be_bytes()); heap.extend([0u8; 6]);
        heap.push(0x21); heap.extend(20u32.to_be_bytes()); heap.extend(0u32.to_be_bytes());
        heap.extend(10u32.to_be_bytes()); heap.extend(0u32.to_be_bytes());
        record(&mut data, 0x1c, &heap);
        // A separate segment exercises accumulative counts.
        let mut heap = vec![0x22]; heap.extend(30u32.to_be_bytes()); heap.extend(0u32.to_be_bytes());
        heap.extend(3u32.to_be_bytes()); heap.extend(10u32.to_be_bytes());
        for id in [20u32, 0, 999] { heap.extend(id.to_be_bytes()); }
        heap.push(0x23); heap.extend(40u32.to_be_bytes()); heap.extend(0u32.to_be_bytes());
        heap.extend(payload.to_be_bytes()); heap.push(8); heap.resize(heap.len() + payload as usize, 0);
        heap.push(0xc3); heap.extend(50u32.to_be_bytes()); heap.extend(0u32.to_be_bytes());
        heap.extend(3u32.to_be_bytes()); heap.push(8);
        heap.push(0xfe); heap.extend(0u32.to_be_bytes()); heap.extend(1u32.to_be_bytes());
        record(&mut data, 0x1c, &heap); record(&mut data, 0x2c, &[]);
        data
    }

    #[test]
    fn counts_include_32_bit_arrays_segments_and_only_resolvable_roots() {
        let sizing = HprofSizing::read(&count_fixture_32(0), None).unwrap();
        let counts = sizing.record_counts;
        assert_eq!(counts.strings, 1); assert_eq!(counts.load_classes, 1);
        assert_eq!(counts.classes, 1); assert_eq!(counts.instances, 1);
        assert_eq!(counts.object_arrays, 1); assert_eq!(counts.primitive_arrays, 2);
        assert_eq!(counts.roots, 2); assert_eq!(counts.node_capacity().unwrap(), 8);
    }

    #[test]
    fn counts_include_64_bit_records_without_treating_roots_as_unique_nodes() {
        let sizing = HprofSizing::read(&crate::indexed::waste::tests::string_fixture(), None).unwrap();
        let counts = sizing.record_counts;
        assert_eq!(counts.strings, 2); assert_eq!(counts.load_classes, 1);
        assert_eq!(counts.classes, 1); assert_eq!(counts.instances, 5);
        assert_eq!(counts.object_arrays, 0); assert_eq!(counts.primitive_arrays, 5);
        assert_eq!(counts.roots, 5); assert_eq!(counts.node_capacity().unwrap(), 17);
    }

    #[test]
    fn capacity_hints_depend_on_records_not_primitive_payload_length() {
        let small = HprofSizing::read(&count_fixture_32(0), None).unwrap().record_counts;
        let large = HprofSizing::read(&count_fixture_32(8 * 1024 * 1024), None).unwrap().record_counts;
        assert_eq!(small.node_capacity().unwrap(), large.node_capacity().unwrap());
        assert_eq!(small.strings, large.strings); assert_eq!(small.classes, large.classes);
        assert_eq!(small.instances, large.instances);
    }

    #[test]
    fn record_count_overflow_and_truncated_inputs_fail_closed() {
        let mut count = usize::MAX;
        assert!(RecordCounts::increment(&mut count).is_err()); assert_eq!(count, usize::MAX);
        assert!(RecordCounts { instances: usize::MAX, ..Default::default() }.node_capacity().is_err());
        let bytes = count_fixture_32(0);
        assert!(HprofSizing::read(&bytes[..bytes.len() - 1], None).is_err());
        assert!(HprofSizing::read_cancellable(&bytes, None, &|| true).is_err());
    }
    #[test]
    fn reference_and_class_pointer_evidence_are_independent() {
        let mut evidence = LayoutEvidence::new(8);
        evidence.observe(0x1000, Some((33, None))).unwrap();
        evidence.observe(0x1098, None).unwrap(); // 16 + 33*4 rounded = 152
        evidence.observe(0x2000, Some((1, Some(1)))).unwrap();
        evidence.observe(0x2018, None).unwrap(); // 24-byte byte[1]
        assert_eq!(evidence.finish(), ObjectLayout::new(8, 4, 4, 8).unwrap());
        let mut mixed = LayoutEvidence::new(8);
        mixed.observe(0x2000, Some((1, Some(1)))).unwrap();
        mixed.observe(0x2018, None).unwrap();
        assert_eq!(mixed.finish(), ObjectLayout::new(8, 8, 4, 8).unwrap());
    }
    #[test]
    fn conflicting_addresses_do_not_invent_compression() {
        let mut evidence = LayoutEvidence::new(8);
        evidence.observe(512, Some((100, None))).unwrap();
        evidence.observe(513, None).unwrap();
        assert_eq!(evidence.finish(), ObjectLayout::new(8, 8, 8, 8).unwrap());
    }
    #[test]
    fn superclass_resolution_is_order_independent_and_cycle_safe() {
        let layout = ObjectLayout::new(8, 4, 4, 8).unwrap();
        let mut classes = HashMap::new();
        classes.insert(
            2,
            ClassShape {
                parent: Some(1),
                references: 1,
                ..Default::default()
            },
        );
        classes.insert(
            1,
            ClassShape {
                references: 1,
                ..Default::default()
            },
        );
        let sizes = resolve_classes(&classes, layout).unwrap();
        assert_eq!(sizes[&1], 16);
        assert_eq!(sizes[&2], 24);
        classes.get_mut(&1).unwrap().parent = Some(2);
        assert!(resolve_classes(&classes, layout).is_err());
        classes.remove(&1);
        assert!(!resolve_classes(&classes, layout).unwrap().contains_key(&2));
    }
}
