//! Versioned fixed-width metadata columns with one shared UTF-8 dictionary.
//! Only the small summary descriptor is JSON; object-sized tables are binary.
use super::{
    cache_writer::{CacheWriter, Receipt},
    class_index::{ClassIndex, ClassInfo, FieldDescriptor},
    parse::Phase1Result,
    string_table::StringTable,
    waste::{ArrayContentRange, LazyStringContents},
};
use crate::{
    waste::{
        BoxedPrimitiveInfo, EmptyCollectionInfo, OverAllocatedCollectionInfo, StringInstanceInfo,
    },
    HeapSummary, WasteRawData,
};
use anyhow::{ensure, Result};
use jvm_hprof::heap_dump::FieldType;
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
const MAGIC: &[u8; 8] = b"HLMETA04";
const SMALL_INPUT_ALLOWANCE: u64 = 512 * 1024 * 1024;
const MAX_SUMMARY: usize = 64 * 1024;

// Coarse encoded-file admission, not a RAM budget. In this format a primitive
// array can add 45 metadata bytes (range + count) for a minimum 14-byte HPROF
// record. Allow four times the source bytes plus descriptor overhead, while
// retaining the prior allowance for small inputs. Per-table validation below
// still checks actual counts, lengths, names, IDs and mapped content ranges.
fn metadata_length_limit(input_bytes: u64) -> Result<u64> {
    Ok(input_bytes
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(MAX_SUMMARY as u64 + 256))
        .ok_or_else(|| anyhow::anyhow!("Metadata admission length overflow"))?
        .max(SMALL_INPUT_ALLOWANCE))
}

fn validate_metadata_length(bytes: u64, input_bytes: u64) -> Result<()> {
    ensure!(
        (16..=metadata_length_limit(input_bytes)?).contains(&bytes),
        "Invalid metadata file length for source capture"
    );
    Ok(())
}

#[derive(Default)]
struct Dictionary {
    names: Vec<Arc<str>>,
    ids: HashMap<Arc<str>, u32>,
}
impl Dictionary {
    fn intern(&mut self, name: Arc<str>) -> Result<u32> {
        if let Some(&id) = self.ids.get(&name) {
            return Ok(id);
        }
        let id = u32::try_from(self.names.len())?;
        self.ids.insert(name.clone(), id);
        self.names.push(name);
        Ok(id)
    }
    fn id(&self, name: &str) -> u64 {
        self.ids[name] as u64
    }
}
fn field_tag(value: FieldType) -> u64 {
    match value {
        FieldType::ObjectId => 2,
        FieldType::Boolean => 4,
        FieldType::Char => 5,
        FieldType::Float => 6,
        FieldType::Double => 7,
        FieldType::Byte => 8,
        FieldType::Short => 9,
        FieldType::Int => 10,
        FieldType::Long => 11,
    }
}
fn field_type(value: u64) -> Result<FieldType> {
    Ok(match value {
        2 => FieldType::ObjectId,
        4 => FieldType::Boolean,
        5 => FieldType::Char,
        6 => FieldType::Float,
        7 => FieldType::Double,
        8 => FieldType::Byte,
        9 => FieldType::Short,
        10 => FieldType::Int,
        11 => FieldType::Long,
        _ => anyhow::bail!("Invalid metadata field type"),
    })
}
fn table<const N: usize, I: Iterator<Item = [u64; N]> + Clone>(
    out: &mut CacheWriter<'_>,
    rows: I,
    widths: [usize; N],
) -> Result<()> {
    out.write_all(&u32::try_from(rows.clone().count())?.to_le_bytes())?;
    // Separate columns avoid struct padding and per-row dictionaries/JSON keys.
    for (column, width) in widths.into_iter().enumerate() {
        for row in rows.clone() {
            let value = row[column];
            ensure!(
                width == 8 || value < (1u64 << (width * 8)),
                "Metadata value overflow"
            );
            out.write_all(&value.to_le_bytes()[..width])?;
        }
    }
    Ok(())
}
#[cfg(test)]
fn write(
    phase: &Phase1Result,
    node_names: Vec<Arc<str>>,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<Receipt> {
    write_impl(phase, node_names, directory, cancel, false)
}
pub(crate) fn write_mapped(
    phase: &Phase1Result,
    node_names: Vec<Arc<str>>,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<Receipt>> {
    let arrays = super::array_catalog::ArrayCatalog::write(
        &phase.waste_raw,
        &phase.node_store,
        directory,
        cancel,
    )?;
    Ok(vec![
        arrays,
        write_impl(phase, node_names, directory, cancel, true)?,
    ])
}
fn write_impl(
    phase: &Phase1Result,
    node_names: Vec<Arc<str>>,
    directory: &Path,
    cancel: &AtomicBool,
    external_arrays: bool,
) -> Result<Receipt> {
    ensure!(
        phase.waste_raw.backing_arrays.is_empty(),
        "Disk cache requires lazy content metadata"
    );
    let contents = phase
        .waste_raw
        .lazy_contents
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Missing mapped input"))?;
    let ranges = &contents.arrays;
    let mut dict = Dictionary::default();
    for name in node_names {
        dict.intern(name)?;
    }
    for (_, info) in phase.class_index.entries() {
        dict.intern(info.class_name.clone())?;
        for field in &info.field_descriptors {
            dict.intern(field.name.clone())?;
        }
    }
    for (_, name) in phase.string_table.entries() {
        dict.intern(name.clone())?;
    }
    let raw = &phase.waste_raw;
    for name in raw
        .empty_collections
        .iter()
        .map(|v| &v.class_name)
        .chain(raw.over_allocated_collections.iter().map(|v| &v.class_name))
        .chain(raw.boxed_primitives.iter().map(|v| &v.class_name))
    {
        dict.intern(name.clone())?;
    }
    let mut out = CacheWriter::new(directory, "metadata.bin", cancel)?;
    out.write_all(MAGIC)?;
    out.write_all(&u32::try_from(phase.node_store.len())?.to_le_bytes())?;
    let summary = serde_json::to_vec(&phase.summary)?;
    ensure!(
        summary.len() <= MAX_SUMMARY,
        "Cache summary exceeds supported limit"
    );
    out.write_all(&(summary.len() as u32).to_le_bytes())?;
    out.write_all(&summary)?;
    out.write_all(&u32::try_from(dict.names.len())?.to_le_bytes())?;
    for name in &dict.names {
        out.write_all(&u32::try_from(name.len())?.to_le_bytes())?;
        out.write_all(name.as_bytes())?;
    }
    let mut field_start = 0u64;
    let dict_ref = &dict;
    table(
        &mut out,
        phase.class_index.entries().map(move |(&id, info)| {
            let start = field_start;
            field_start += info.field_descriptors.len() as u64;
            [
                id,
                dict_ref.id(&info.class_name),
                info.instance_size as u64,
                info.super_class_id.unwrap_or(0),
                u64::from(info.super_class_id.is_some()),
                start,
                info.field_descriptors.len() as u64,
            ]
        }),
        [8, 4, 4, 8, 1, 4, 4],
    )?;
    table(
        &mut out,
        phase.class_index.entries().flat_map(|(_, info)| {
            info.field_descriptors
                .iter()
                .map(|field| [dict.id(&field.name), field_tag(field.field_type)])
        }),
        [4, 1],
    )?;
    table(
        &mut out,
        phase
            .string_table
            .entries()
            .map(|(&id, name)| [id, dict.id(name)]),
        [8, 4],
    )?;
    table(&mut out, phase.gc_root_ids.iter().map(|&id| [id]), [8])?;
    table(&mut out, phase.classloader_ids.iter().map(|&id| [id]), [8])?;
    out.write_all(&raw.reference_bytes.to_le_bytes())?;
    table(
        &mut out,
        raw.string_instances
            .iter()
            .map(|v| [v.value_array_id, v.shallow_size]),
        [8, 8],
    )?;
    table(
        &mut out,
        raw.empty_collections
            .iter()
            .map(|v| [dict.id(&v.class_name), v.shallow_size]),
        [4, 8],
    )?;
    if external_arrays {
        table(&mut out, std::iter::empty::<[u64; 2]>(), [8, 4])?;
    } else {
        table(
            &mut out,
            raw.array_element_counts
                .iter()
                .map(|(&id, &count)| [id, count as u64]),
            [8, 4],
        )?;
    }
    table(
        &mut out,
        raw.over_allocated_collections
            .iter()
            .map(|v| [dict.id(&v.class_name), v.size as u64, v.capacity as u64]),
        [4, 4, 4],
    )?;
    table(
        &mut out,
        raw.boxed_primitives
            .iter()
            .map(|v| [dict.id(&v.class_name), v.shallow_size]),
        [4, 8],
    )?;
    if external_arrays {
        table(&mut out, std::iter::empty::<[u64; 5]>(), [8, 8, 8, 8, 1])?;
    } else {
        table(
            &mut out,
            ranges.iter().map(|(&id, v)| {
                [
                    id,
                    v.offset as u64,
                    v.length as u64,
                    v.shallow_size,
                    u64::from(v.is_char),
                ]
            }),
            [8, 8, 8, 8, 1],
        )?;
    }
    let receipt = out.finish()?;
    validate_metadata_length(receipt.bytes, contents.mapping.len() as u64)?;
    Ok(receipt)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    cancel: &'a AtomicBool,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        super::disk_edges::check(self.cancel)?;
        let result = self
            .bytes
            .get(..size)
            .ok_or_else(|| anyhow::anyhow!("Truncated cache metadata"))?;
        self.bytes = &self.bytes[size..];
        Ok(result)
    }
    fn u32(&mut self) -> Result<usize> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?) as usize)
    }
    fn columns<const N: usize>(&mut self, widths: [usize; N]) -> Result<Columns<'a, N>> {
        let count = self.u32()?;
        let size = count
            .checked_mul(widths.iter().sum())
            .ok_or_else(|| anyhow::anyhow!("Metadata length overflow"))?;
        ensure!(size <= self.bytes.len(), "Invalid metadata table length");
        let mut columns = [&[][..]; N];
        for i in 0..N {
            columns[i] = self.take(count * widths[i])?;
        }
        Ok(Columns {
            columns,
            widths,
            count,
        })
    }
}
struct Columns<'a, const N: usize> {
    columns: [&'a [u8]; N],
    widths: [usize; N],
    count: usize,
}
impl<const N: usize> Columns<'_, N> {
    fn value(&self, row: usize, column: usize) -> u64 {
        let width = self.widths[column];
        let mut bytes = [0u8; 8];
        bytes[..width].copy_from_slice(&self.columns[column][row * width..(row + 1) * width]);
        u64::from_le_bytes(bytes)
    }
}
pub(crate) struct Metadata {
    pub summary: HeapSummary,
    pub class_index: ClassIndex,
    pub string_table: StringTable,
    pub gc_root_ids: Vec<u64>,
    pub classloader_ids: HashSet<u64>,
    pub waste_raw: WasteRawData,
    pub names: Vec<Arc<str>>,
    pub nodes: usize,
}
fn decode(bytes: &[u8], mapping: Arc<memmap2::Mmap>, cancel: &AtomicBool) -> Result<Metadata> {
    validate_metadata_length(bytes.len() as u64, mapping.len() as u64)?;
    let mut input = Cursor { bytes, cancel };
    ensure!(input.take(8)? == MAGIC, "Unsupported metadata format");
    let nodes = input.u32()?;
    ensure!(nodes > 0 && nodes < u32::MAX as usize, "Invalid node count");
    let length = input.u32()?;
    ensure!(length <= MAX_SUMMARY, "Invalid cache summary length");
    let summary: HeapSummary = serde_json::from_slice(input.take(length)?)?;
    let count = input.u32()?;
    ensure!(count <= input.bytes.len() / 4, "Invalid dictionary count");
    // A declared dictionary count is not evidence that its entries are valid.
    // Grow only after validating each entry, rather than preallocating from an
    // attacker-controlled count in a large but malformed mapped file.
    let mut names = Vec::new();
    let mut unique = HashSet::new();
    for _ in 0..count {
        let length = input.u32()?;
        let name: Arc<str> = Arc::from(std::str::from_utf8(input.take(length)?)?);
        ensure!(unique.insert(name.clone()), "Duplicate dictionary entry");
        names.push(name);
    }
    drop(unique);
    let name = |id: u64| -> Result<Arc<str>> {
        names
            .get(usize::try_from(id)?)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Invalid metadata name index"))
    };
    let classes = input.columns([8, 4, 4, 8, 1, 4, 4])?;
    ensure!(classes.count <= nodes, "Invalid class count");
    let fields = input.columns([4, 1])?;
    let mut class_index = ClassIndex::with_capacity(classes.count);
    let mut expected_start = 0usize;
    for row in 0..classes.count {
        super::disk_edges::check(cancel)?;
        let id = classes.value(row, 0);
        let start = usize::try_from(classes.value(row, 5))?;
        let count = usize::try_from(classes.value(row, 6))?;
        ensure!(
            id != 0
                && class_index.get(id).is_none()
                && start == expected_start
                && count <= fields.count.saturating_sub(start),
            "Invalid class field range or duplicate class ID"
        );
        let has_super = classes.value(row, 4);
        ensure!(has_super <= 1, "Invalid superclass flag");
        let superclass = classes.value(row, 3);
        ensure!(
            has_super != 0 || superclass == 0,
            "Invalid superclass value"
        );
        let mut descriptors = Vec::with_capacity(count);
        for field in start..start + count {
            descriptors.push(FieldDescriptor {
                name: name(fields.value(field, 0))?,
                field_type: field_type(fields.value(field, 1))?,
            });
        }
        expected_start += count;
        class_index.insert(
            id,
            ClassInfo {
                class_name: name(classes.value(row, 1))?,
                instance_size: classes.value(row, 2) as u32,
                super_class_id: if has_super == 1 {
                    Some(superclass)
                } else {
                    None
                },
                field_descriptors: descriptors,
            },
        );
    }
    ensure!(expected_start == fields.count, "Unclaimed metadata fields");
    let strings = input.columns([8, 4])?;
    let mut string_table = StringTable::with_capacity(strings.count);
    for row in 0..strings.count {
        let id = strings.value(row, 0);
        ensure!(string_table.get(id).is_none(), "Duplicate string ID");
        string_table.insert_shared(id, name(strings.value(row, 1))?);
    }
    let roots = input.columns([8])?;
    // Several root records can identify the same object; preserve their multiplicity.
    let gc_root_ids = (0..roots.count).map(|i| roots.value(i, 0)).collect();
    let loaders = input.columns([8])?;
    ensure!(loaders.count <= nodes, "Invalid classloader count");
    let mut classloader_ids = HashSet::with_capacity(loaders.count);
    for row in 0..loaders.count {
        ensure!(
            classloader_ids.insert(loaders.value(row, 0)),
            "Duplicate classloader ID"
        );
    }
    let mut raw = WasteRawData::new();
    raw.reference_bytes = u64::from_le_bytes(input.take(8)?.try_into()?);
    ensure!(
        [4, 8].contains(&raw.reference_bytes),
        "Invalid reference width"
    );
    let strings = input.columns([8, 8])?;
    ensure!(strings.count <= nodes, "Invalid string instance count");
    for row in 0..strings.count {
        raw.string_instances.push(StringInstanceInfo {
            value_array_id: strings.value(row, 0),
            shallow_size: strings.value(row, 1),
        });
    }
    let empty = input.columns([4, 8])?;
    ensure!(empty.count <= nodes, "Invalid empty collection count");
    for row in 0..empty.count {
        raw.empty_collections.push(EmptyCollectionInfo {
            class_name: name(empty.value(row, 0))?,
            shallow_size: empty.value(row, 1),
        });
    }
    let arrays = input.columns([8, 4])?;
    ensure!(arrays.count <= nodes, "Invalid array count");
    for row in 0..arrays.count {
        ensure!(
            raw.array_element_counts
                .insert(arrays.value(row, 0), arrays.value(row, 1) as u32)
                .is_none(),
            "Duplicate array ID"
        );
    }
    let over = input.columns([4, 4, 4])?;
    ensure!(over.count <= nodes, "Invalid collection count");
    for row in 0..over.count {
        raw.over_allocated_collections
            .push(OverAllocatedCollectionInfo {
                class_name: name(over.value(row, 0))?,
                size: over.value(row, 1) as u32,
                capacity: over.value(row, 2) as u32,
            });
    }
    let boxed = input.columns([4, 8])?;
    ensure!(boxed.count <= nodes, "Invalid boxed count");
    for row in 0..boxed.count {
        raw.boxed_primitives.push(BoxedPrimitiveInfo {
            class_name: name(boxed.value(row, 0))?,
            shallow_size: boxed.value(row, 1),
        });
    }
    let ranges = input.columns([8, 8, 8, 8, 1])?;
    ensure!(ranges.count <= nodes, "Invalid range count");
    let mut contents = HashMap::with_capacity(ranges.count);
    for row in 0..ranges.count {
        super::disk_edges::check(cancel)?;
        let offset = usize::try_from(ranges.value(row, 1))?;
        let length = usize::try_from(ranges.value(row, 2))?;
        let is_char = ranges.value(row, 4);
        ensure!(
            is_char <= 1 && (is_char == 0 || length % 2 == 0),
            "Invalid content type"
        );
        ensure!(
            offset
                .checked_add(length)
                .is_some_and(|end| end <= mapping.len()),
            "Invalid content offset"
        );
        ensure!(
            contents
                .insert(
                    ranges.value(row, 0),
                    ArrayContentRange {
                        offset,
                        length,
                        shallow_size: ranges.value(row, 3),
                        is_char: is_char == 1
                    }
                )
                .is_none(),
            "Duplicate content ID"
        );
    }
    ensure!(input.bytes.is_empty(), "Unexpected metadata trailing bytes");
    super::disk_edges::check(cancel)?;
    raw.lazy_contents = Some(Arc::new(LazyStringContents::new(mapping, contents)));
    Ok(Metadata {
        summary,
        class_index,
        string_table,
        gc_root_ids,
        classloader_ids,
        waste_raw: raw,
        names,
        nodes,
    })
}
pub(crate) fn read(
    directory: &Path,
    mapping: Arc<memmap2::Mmap>,
    cancel: &AtomicBool,
) -> Result<Metadata> {
    let file = std::fs::File::open(directory.join("metadata.bin"))?;
    validate_metadata_length(file.metadata()?.len(), mapping.len() as u64)?;
    super::disk_edges::check(cancel)?;
    let bytes = unsafe { memmap2::Mmap::map(&file)? };
    let input_bytes = mapping.len();
    let mut metadata = decode(&bytes, mapping, cancel)?;
    ensure!(
        metadata.waste_raw.array_element_counts.is_empty()
            && metadata
                .waste_raw
                .lazy_contents
                .as_ref()
                .unwrap()
                .arrays
                .is_empty(),
        "Unexpected inline array catalogs"
    );
    metadata.waste_raw.mapped_arrays = Some(Arc::new(super::array_catalog::ArrayCatalog::map(
        directory,
        metadata.nodes,
        input_bytes,
        cancel,
    )?));
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_admission_scales_past_old_ceiling_and_checks_overflow() {
        let old = SMALL_INPUT_ALLOWANCE;
        assert_eq!(metadata_length_limit(0).unwrap(), old);
        assert!(validate_metadata_length(old, 1).is_ok());
        assert!(validate_metadata_length(old + 1, 1).is_err());
        let source = 200 * 1024 * 1024;
        assert!(validate_metadata_length(549_145_378, source).is_ok());
        let limit = metadata_length_limit(source).unwrap();
        assert!(validate_metadata_length(limit, source).is_ok());
        assert!(validate_metadata_length(limit + 1, source).is_err());
        assert!(validate_metadata_length(15, source).is_err());
        assert!(metadata_length_limit(u64::MAX).is_err());
        assert!(metadata_length_limit(u64::MAX / 4).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn mapped_reader_accepts_large_admission_but_still_rejects_invalid_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(dir.path().join("metadata.bin")).unwrap();
        // Sparse files/mappings test the former ceiling without allocating or
        // writing hundreds of MiB in the unit-test process.
        file.set_len(SMALL_INPUT_ALLOWANCE + 4096).unwrap();
        let source = memmap2::MmapMut::map_anon(200 * 1024 * 1024).unwrap();
        let source = Arc::new(source.make_read_only().unwrap());
        let error = read(dir.path(), source, &AtomicBool::new(false))
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "Unsupported metadata format");
        let (_, small_source) = fixture();
        let error = read(dir.path(), small_source, &AtomicBool::new(false))
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            "Invalid metadata file length for source capture"
        );
    }

    fn fixture() -> (Phase1Result, Arc<memmap2::Mmap>) {
        let bytes = super::super::waste::tests::string_fixture();
        let mut mapped = memmap2::MmapMut::map_anon(bytes.len()).unwrap();
        mapped.copy_from_slice(&bytes);
        let mapped = Arc::new(mapped.make_read_only().unwrap());
        (
            super::super::parse::parse_indexed_phase1_mapped(mapped.clone(), None)
                .unwrap()
                .0,
            mapped,
        )
    }
    fn encoded(phase: &Phase1Result) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut names = vec![];
        for node in phase.node_store.iter() {
            if !names.contains(node.class_name) {
                names.push(node.class_name.clone());
            }
        }
        write(phase, names, dir.path(), &cancel).unwrap();
        std::fs::read(dir.path().join("metadata.bin")).unwrap()
    }
    #[test]
    fn binary_roundtrip_shares_dictionary_and_preserves_lazy_metadata() {
        let (phase, mapping) = fixture();
        let bytes = encoded(&phase);
        let decoded = decode(&bytes, mapping, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            serde_json::to_value(&decoded.summary).unwrap(),
            serde_json::to_value(&phase.summary).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&decoded.class_index).unwrap(),
            serde_json::to_value(&phase.class_index).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&decoded.string_table).unwrap(),
            serde_json::to_value(&phase.string_table).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&decoded.waste_raw).unwrap(),
            serde_json::to_value(&phase.waste_raw).unwrap()
        );
        for (_, info) in decoded.class_index.entries() {
            assert!(decoded
                .names
                .iter()
                .any(|v| Arc::ptr_eq(v, &info.class_name)));
        }
        assert_eq!(
            decoded.waste_raw.lazy_contents.unwrap().arrays.len(),
            phase.waste_raw.lazy_contents.as_ref().unwrap().arrays.len()
        );
        assert!(!bytes.windows(7).any(|v| v == b"preview"));
    }
    #[test]
    fn every_truncation_bad_magic_and_trailing_bytes_fail_closed() {
        let (phase, mapping) = fixture();
        let bytes = encoded(&phase);
        let cancel = AtomicBool::new(false);
        for length in 0..bytes.len() {
            assert!(
                decode(&bytes[..length], mapping.clone(), &cancel).is_err(),
                "length {length}"
            );
        }
        let mut bad = bytes.clone();
        bad[0] ^= 1;
        assert!(decode(&bad, mapping.clone(), &cancel).is_err());
        let mut bad = bytes;
        bad.push(0);
        assert!(decode(&bad, mapping, &cancel).is_err());
    }
    #[test]
    fn malformed_counts_invalid_utf8_and_cancel_are_rejected_before_allocation() {
        let (phase, mapping) = fixture();
        let bytes = encoded(&phase);
        let cancel = AtomicBool::new(false);
        let summary_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let dictionary = 16 + summary_len;
        let mut bad = bytes.clone();
        bad[dictionary..dictionary + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&bad, mapping.clone(), &cancel).is_err());
        let mut bad = bytes.clone();
        bad[dictionary + 4..dictionary + 8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&bad, mapping.clone(), &cancel).is_err());
        let mut bad = bytes.clone();
        bad[dictionary + 8] = 0xff;
        assert!(decode(&bad, mapping.clone(), &cancel).is_err());
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(decode(&bytes, mapping, &cancel).is_err());
    }

    #[test]
    fn repeated_root_records_are_not_confused_with_unique_node_count() {
        let (mut phase, mapping) = fixture();
        let root = phase.gc_root_ids[0];
        phase.gc_root_ids = vec![root; phase.node_store.len() + 5];
        let decoded = decode(&encoded(&phase), mapping, &AtomicBool::new(false)).unwrap();
        assert_eq!(decoded.gc_root_ids, phase.gc_root_ids);
    }

    #[test]
    fn invalid_cross_column_names_fields_ids_and_ranges_are_rejected() {
        let (mut phase, mapping) = fixture();
        let info = phase.class_index.entries().next().unwrap().1.clone();
        phase.class_index.insert(9999, info);
        let bytes = encoded(&phase);
        let cancel = AtomicBool::new(false);
        let mut input = Cursor {
            bytes: &bytes,
            cancel: &cancel,
        };
        input.take(12).unwrap();
        let length = input.u32().unwrap();
        input.take(length).unwrap();
        let count = input.u32().unwrap();
        for _ in 0..count {
            let length = input.u32().unwrap();
            input.take(length).unwrap();
        }
        let class_start = bytes.len() - input.bytes.len();
        let classes = input.columns([8, 4, 4, 8, 1, 4, 4]).unwrap();
        let field_start = bytes.len() - input.bytes.len();
        let fields = input.columns([4, 1]).unwrap();
        input.columns([8, 4]).unwrap();
        input.columns([8]).unwrap();
        input.columns([8]).unwrap();
        input.take(8).unwrap();
        input.columns([8, 8]).unwrap();
        input.columns([4, 8]).unwrap();
        input.columns([8, 4]).unwrap();
        input.columns([4, 4, 4]).unwrap();
        input.columns([4, 8]).unwrap();
        let range_start = bytes.len() - input.bytes.len();
        let ranges = input.columns([8, 8, 8, 8, 1]).unwrap();
        let n = classes.count;
        let r = ranges.count;
        assert!(n >= 2 && fields.count > 0 && r > 0);
        let mutations = [
            (class_start + 4 + 8 * n, u32::MAX.to_le_bytes().to_vec()), // name index
            (class_start + 4 + 25 * n, u32::MAX.to_le_bytes().to_vec()), // field start
            (class_start + 4 + 24 * n, vec![2]),                        // superclass presence flag
            (
                class_start + 4 + 8,
                bytes[class_start + 4..class_start + 12].to_vec(),
            ), // duplicate class ID
            (field_start + 4 + 4 * fields.count, vec![3]),              // invalid HPROF type
            (range_start + 4 + 8 * r, u64::MAX.to_le_bytes().to_vec()), // payload offset
            (range_start + 4 + 32 * r, vec![2]),                        // invalid bool
        ];
        for (offset, value) in mutations {
            let mut bad = bytes.clone();
            bad[offset..offset + value.len()].copy_from_slice(&value);
            assert!(
                decode(&bad, mapping.clone(), &cancel).is_err(),
                "offset {offset}"
            );
        }
    }
}
