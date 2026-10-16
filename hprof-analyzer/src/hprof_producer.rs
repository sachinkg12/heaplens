//! Bounded, local-only producer evidence from the canonical System.props graph.
//! No string search, environment-JDK assumption, network, or per-object index.
//! Missing/unsupported evidence preserves the ordinary estimated-size policy.
use crate::jvm_layout_profile::{self, InjectedFields};
use anyhow::{bail, Result};
use jvm_hprof::{
    heap_dump::{Class, FieldType, FieldValue, SubRecord},
    IdSize, Record, SubRecords,
};
use std::collections::{HashMap, HashSet};

const MAX_CLASSES: usize = 65_536;
const MAX_TARGETS: usize = 1024;
const MAX_PROBE_BYTES: usize = 128 * 1024 * 1024;
const MAX_PROBE_RECORDS: usize = 2_000_000;
const PAGE_RECORDS: usize = 4096;
const MAX_PAGES: usize = 65_536;
const KEYS: [&str; 3] = ["java.vm.name", "java.vm.vendor", "java.vm.version"];

#[derive(Default)]
pub(crate) struct Metadata<'a> {
    names: HashMap<u64, &'a str>,
    loads: HashMap<u64, u64>,
    classes: HashMap<u64, Class<'a>>,
    pages: Vec<Page<'a>>,
    disabled: bool,
}
// Borrowed parser checkpoints, not a per-object address map. Ranges only
// prune candidates: object IDs may be unordered and ranges may overlap.
struct Page<'a> {
    cursor: SubRecords<'a>,
    count: usize,
    min: u64,
    max: u64,
}
pub(crate) struct Detection {
    pub status: &'static str,
    pub profile: Option<&'static str>,
    pub injected: HashMap<u64, InjectedFields>,
}
impl Detection {
    fn unknown(status: &'static str) -> Self {
        Self {
            status,
            profile: None,
            injected: HashMap::new(),
        }
    }
}

fn relevant(s: &str) -> bool {
    s.starts_with("java/lang/")
        || s.starts_with("java/util/")
        || matches!(
            s,
            "props"
                | "map"
                | "table"
                | "key"
                | "val"
                | "value"
                | "next"
                | "first"
                | "coder"
                | "parent"
                | "name"
                | "unnamedModule"
                | "nameAndId"
                | "parallelLockMap"
                | "package2certs"
                | "classes"
                | "defaultDomain"
                | "packages"
                | "libraries"
                | "assertionLock"
                | "defaultAssertionStatus"
                | "packageAssertionStatus"
                | "classAssertionStatus"
                | "classLoaderValueMap"
                | "eetop"
                | "tid"
                | "interrupted"
                | "contextClassLoader"
                | "inheritedAccessControlContext"
                | "holder"
                | "threadLocals"
                | "inheritableThreadLocals"
                | "scopedValueBindings"
                | "interruptLock"
                | "parkBlocker"
                | "nioBlocker"
                | "cont"
                | "uncaughtExceptionHandler"
                | "threadLocalRandomSeed"
                | "threadLocalRandomProbe"
                | "threadLocalRandomSecondarySeed"
                | "container"
                | "headStackableScopes"
        )
}

impl<'a> Metadata<'a> {
    pub fn checkpoint(&mut self, cursor: SubRecords<'a>) {
        if self.disabled {
            return;
        }
        if self.pages.len() == MAX_PAGES {
            self.disable();
            return;
        }
        self.pages.push(Page {
            cursor,
            count: 0,
            min: u64::MAX,
            max: 0,
        });
    }
    pub fn observe(&mut self, sub: &SubRecord<'a>) {
        if let Some(page) = self.pages.last_mut() {
            page.count += 1;
            let id = match sub {
                SubRecord::Instance(o) => o.obj_id().id(),
                SubRecord::ObjectArray(o) => o.obj_id().id(),
                SubRecord::PrimitiveArray(o) => o.obj_id().id(),
                _ => return,
            };
            page.min = page.min.min(id);
            page.max = page.max.max(id);
        }
    }
    pub fn page_records() -> usize {
        PAGE_RECORDS
    }
    pub fn record(&mut self, record: &Record<'a>) -> Result<()> {
        if self.disabled {
            return Ok(());
        }
        if let Some(s) = record.as_utf_8() {
            let s = s.map_err(|_| anyhow::anyhow!("Invalid producer metadata"))?;
            if let Ok(text) = std::str::from_utf8(s.text()) {
                if text.len() <= 256 && relevant(text) {
                    if self.names.len() >= MAX_CLASSES {
                        self.disable();
                        return Ok(());
                    }
                    if self
                        .names
                        .insert(s.name_id().id(), text)
                        .is_some_and(|old| old != text)
                    {
                        self.disable();
                    }
                }
            }
        }
        if let Some(c) = record.as_load_class() {
            let c = c.map_err(|_| anyhow::anyhow!("Invalid producer class metadata"))?;
            if self.loads.len() >= MAX_CLASSES {
                self.disable();
                return Ok(());
            }
            if self
                .loads
                .insert(c.class_obj_id().id(), c.class_name_id().id())
                .is_some_and(|old| old != c.class_name_id().id())
            {
                self.disable();
            }
        }
        Ok(())
    }
    pub fn class(&mut self, class: Class<'a>) {
        if self.disabled {
            return;
        }
        if self.classes.len() >= MAX_CLASSES
            || self.classes.insert(class.obj_id().id(), class).is_some()
        {
            self.disable();
        }
    }
    fn disable(&mut self) {
        self.disabled = true;
        self.names.clear();
        self.loads.clear();
        self.classes.clear();
        self.pages.clear();
    }
    fn class_name(&self, id: u64) -> Option<&str> {
        self.names.get(self.loads.get(&id)?).copied()
    }
    fn bootstrap(&self, name: &str) -> Option<&Class<'a>> {
        let mut matches = self.classes.values().filter(|c| {
            c.class_loader_obj_id().is_none() && self.class_name(c.obj_id().id()) == Some(name)
        });
        let result = matches.next()?;
        if matches.next().is_some() {
            None
        } else {
            Some(result)
        }
    }
    fn field(&self, object: &Body<'a>, name: &str, width: usize) -> Option<(FieldType, u64)> {
        let Body::Instance { class, bytes } = object else {
            return None;
        };
        let mut current = Some(*class);
        let mut offset = 0usize;
        let mut visited = HashSet::new();
        while let Some(id) = current {
            if visited.len() >= 64 || !visited.insert(id) {
                return None;
            }
            let c = self.classes.get(&id)?;
            for f in c.instance_field_descriptors() {
                let f = f.ok()?;
                let kind = f.field_type();
                let len = if matches!(kind, FieldType::ObjectId) {
                    width
                } else {
                    super::hprof_sizing::field_bytes(kind) as usize
                };
                let end = offset.checked_add(len)?;
                let raw = bytes.get(offset..end)?;
                if self.names.get(&f.name_id().id()).copied() == Some(name) {
                    return Some((kind, raw.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b))));
                }
                offset = end;
            }
            current = c.super_class_obj_id().map(|id| id.id());
        }
        None
    }
    fn reference(&self, object: &Body<'a>, name: &str, width: usize) -> Option<u64> {
        let (kind, value) = self.field(object, name, width)?;
        (matches!(kind, FieldType::ObjectId) && value != 0).then_some(value)
    }
    fn is_type(&self, body: &Body<'a>, name: &str) -> bool {
        matches!(body, Body::Instance { class, .. } if self.bootstrap(name).is_some_and(|c| c.obj_id().id() == *class))
    }
    fn shape(&self, class: &Class<'a>, expected: &[(&str, u8)]) -> bool {
        let actual: Option<Vec<_>> = class
            .instance_field_descriptors()
            .map(|f| {
                let f = f.ok()?;
                Some((
                    self.names.get(&f.name_id().id()).copied()?,
                    tag(f.field_type()),
                ))
            })
            .collect();
        let Some(mut actual) = actual else {
            return false;
        };
        let mut expected = expected.to_vec();
        actual.sort_unstable();
        expected.sort_unstable();
        actual == expected
    }
    pub fn detect(
        &self,
        data: &'a [u8],
        id_size: IdSize,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Detection> {
        if self.disabled {
            return Ok(Detection::unknown("metadata-limit-or-ambiguity"));
        }
        let width = if matches!(id_size, IdSize::U64) { 8 } else { 4 };
        if width != 8 {
            return Ok(Detection::unknown("unsupported-word-width"));
        }
        let Some(loader) = self.bootstrap("java/lang/ClassLoader") else {
            return Ok(Detection::unknown("unsupported-class-shape"));
        };
        let Some(thread) = self.bootstrap("java/lang/Thread") else {
            return Ok(Detection::unknown("unsupported-class-shape"));
        };
        let Some(object) = self.bootstrap("java/lang/Object") else {
            return Ok(Detection::unknown("unsupported-class-shape"));
        };
        if loader.super_class_obj_id().map(|id| id.id()) != Some(object.obj_id().id())
            || thread.super_class_obj_id().map(|id| id.id()) != Some(object.obj_id().id())
            || object.super_class_obj_id().is_some()
            || object.instance_field_descriptors().next().is_some()
            || !self.shape(loader, LOADER_FIELDS)
            || !self.shape(thread, THREAD_FIELDS)
        {
            return Ok(Detection::unknown("unsupported-class-shape"));
        }
        let mut budget = Budget::default();
        let Some(properties) = self.properties(data, width, &mut budget, cancelled)? else {
            return Ok(Detection::unknown(if budget.exhausted {
                "probe-limit"
            } else {
                "unavailable"
            }));
        };
        let Some(profile) =
            jvm_layout_profile::select(&properties[0], &properties[1], &properties[2])
        else {
            return Ok(Detection::unknown("unsupported-producer"));
        };
        Ok(Detection {
            status: "system-properties-and-bootstrap-shapes",
            profile: Some(profile),
            injected: [
                (loader.obj_id().id(), jvm_layout_profile::CLASS_LOADER),
                (thread.obj_id().id(), jvm_layout_profile::THREAD_21),
            ]
            .into_iter()
            .collect(),
        })
    }
    fn properties(
        &self,
        data: &'a [u8],
        width: usize,
        budget: &mut Budget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<[String; 3]>> {
        // A macro makes unsupported optional evidence fall back without treating
        // it as corrupt heap data. Cancellation remains an actual error.
        macro_rules! some {
            ($e:expr) => {
                match $e {
                    Some(v) => v,
                    None => return Ok(None),
                }
            };
        }
        let system = some!(self.bootstrap("java/lang/System"));
        let mut roots = system
            .static_fields()
            .filter_map(|f| f.ok())
            .filter(|f| self.names.get(&f.name_id().id()).copied() == Some("props"));
        let root = some!(roots.next());
        if roots.next().is_some() {
            return Ok(None);
        }
        let props = match root.value() {
            FieldValue::ObjectId(Some(id)) => id.id(),
            _ => return Ok(None),
        };
        let objects = some!(lookup(&self.pages, &[props], budget, cancelled)?);
        let p = some!(objects.get(&props));
        if !self.is_type(p, "java/util/Properties") {
            return Ok(None);
        }
        let map = some!(self.reference(p, "map", width));
        let objects = some!(lookup(&self.pages, &[map], budget, cancelled)?);
        let m = some!(objects.get(&map));
        if !self.is_type(m, "java/util/concurrent/ConcurrentHashMap") {
            return Ok(None);
        }
        let table = some!(self.reference(m, "table", width));
        let objects = some!(lookup(&self.pages, &[table], budget, cancelled)?);
        let Body::Array(raw) = some!(objects.get(&table)) else {
            return Ok(None);
        };
        let mut pending = some!(ids(raw, width));
        let mut visited = HashSet::new();
        let mut pairs = Vec::new();
        for _ in 0..16 {
            if pending.is_empty() {
                break;
            }
            if visited.len() + pending.len() > MAX_TARGETS {
                return Ok(None);
            }
            let objects = some!(lookup(&self.pages, &pending, budget, cancelled)?);
            let mut next = Vec::new();
            for id in pending {
                if !visited.insert(id) {
                    return Ok(None);
                }
                let body = some!(objects.get(&id));
                if self.is_type(body, "java/util/concurrent/ConcurrentHashMap$TreeBin") {
                    if let Some(first) = self.reference(body, "first", width) {
                        next.push(first);
                    }
                } else {
                    let Body::Instance { class, .. } = body else {
                        return Ok(None);
                    };
                    let node = some!(self.bootstrap("java/util/concurrent/ConcurrentHashMap$Node"));
                    let child = self
                        .classes
                        .get(class)
                        .and_then(|c| c.super_class_obj_id())
                        .map(|id| id.id());
                    if *class != node.obj_id().id() && child != Some(node.obj_id().id()) {
                        return Ok(None);
                    }
                    pairs.push((
                        some!(self.reference(body, "key", width)),
                        some!(self.reference(body, "val", width)),
                    ));
                    if let Some(id) = self.reference(body, "next", width) {
                        next.push(id);
                    }
                }
            }
            pending = next;
        }
        if !pending.is_empty() || pairs.len() > MAX_TARGETS {
            return Ok(None);
        }
        let keys: Vec<_> = pairs.iter().map(|p| p.0).collect();
        let decoded = some!(self.strings(data, &keys, width, budget, cancelled)?);
        let mut values = [0u64; 3];
        for (key, value) in pairs {
            if let Some(index) = decoded
                .get(&key)
                .and_then(|key| KEYS.iter().position(|known| known == key))
            {
                if values[index] != 0 {
                    return Ok(None);
                }
                values[index] = value;
            }
        }
        if values.contains(&0) {
            return Ok(None);
        }
        let decoded = some!(self.strings(data, &values, width, budget, cancelled)?);
        Ok(Some([
            some!(decoded.get(&values[0])).clone(),
            some!(decoded.get(&values[1])).clone(),
            some!(decoded.get(&values[2])).clone(),
        ]))
    }
    fn strings(
        &self,
        _data: &'a [u8],
        ids: &[u64],
        width: usize,
        budget: &mut Budget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<HashMap<u64, String>>> {
        let Some(objects) = lookup(&self.pages, ids, budget, cancelled)? else {
            return Ok(None);
        };
        let mut arrays = Vec::new();
        let mut descriptions = Vec::new();
        for &id in ids {
            let Some(body) = objects.get(&id) else {
                return Ok(None);
            };
            if !self.is_type(body, "java/lang/String") {
                return Ok(None);
            }
            let Some(array) = self.reference(body, "value", width) else {
                return Ok(None);
            };
            let Some((FieldType::Byte, coder)) = self.field(body, "coder", width) else {
                return Ok(None);
            };
            if coder != 0 {
                return Ok(None);
            } // Producer keys/values are ASCII in the supported profile.
            arrays.push(array);
            descriptions.push((id, array));
        }
        let Some(objects) = lookup(&self.pages, &arrays, budget, cancelled)? else {
            return Ok(None);
        };
        let mut result = HashMap::new();
        for (id, array) in descriptions {
            let Some(Body::Bytes(raw)) = objects.get(&array) else {
                return Ok(None);
            };
            if raw.len() > 256 || !raw.is_ascii() {
                return Ok(None);
            }
            let Ok(text) = std::str::from_utf8(raw) else {
                return Ok(None);
            };
            result.insert(id, text.to_owned());
        }
        Ok(Some(result))
    }
}

enum Body<'a> {
    Instance { class: u64, bytes: &'a [u8] },
    Array(&'a [u8]),
    Bytes(&'a [u8]),
}
#[derive(Default)]
struct Budget {
    bytes: usize,
    records: usize,
    exhausted: bool,
}
impl Budget {
    fn charge(&mut self, bytes: usize) -> bool {
        self.bytes = self.bytes.saturating_add(bytes);
        self.records = self.records.saturating_add(1);
        self.exhausted |= self.bytes > MAX_PROBE_BYTES || self.records > MAX_PROBE_RECORDS;
        !self.exhausted
    }
}
fn ids(raw: &[u8], width: usize) -> Option<Vec<u64>> {
    if raw.len() % width != 0 || raw.len() / width > MAX_TARGETS {
        return None;
    }
    Some(
        raw.chunks_exact(width)
            .map(|b| b.iter().fold(0u64, |v, b| (v << 8) | u64::from(*b)))
            .filter(|&v| v != 0)
            .collect(),
    )
}
fn lookup<'a>(
    pages: &[Page<'a>],
    targets: &[u64],
    budget: &mut Budget,
    cancelled: &dyn Fn() -> bool,
) -> Result<Option<HashMap<u64, Body<'a>>>> {
    if cancelled() {
        bail!("Sizing cancelled");
    }
    if targets.len() > MAX_TARGETS || targets.contains(&0) || budget.exhausted {
        return Ok(None);
    }
    let targets: HashSet<_> = targets.iter().copied().collect();
    let mut found = HashMap::new();
    if targets.is_empty() {
        return Ok(Some(found));
    }
    for page in pages {
        if cancelled() {
            bail!("Sizing cancelled");
        }
        if !targets.iter().any(|id| (page.min..=page.max).contains(id)) {
            continue;
        }
        for sub in page.cursor.clone().take(page.count) {
            if cancelled() {
                bail!("Sizing cancelled");
            }
            let sub = sub.map_err(|_| anyhow::anyhow!("Invalid producer object"))?;
            let (id, bytes, body) = match sub {
                SubRecord::Instance(i) => (
                    i.obj_id().id(),
                    25 + if targets.contains(&i.obj_id().id()) {
                        i.fields().len()
                    } else {
                        0
                    },
                    Some(Body::Instance {
                        class: i.class_obj_id().id(),
                        bytes: i.fields(),
                    }),
                ),
                SubRecord::ObjectArray(a) => (
                    a.obj_id().id(),
                    25 + if targets.contains(&a.obj_id().id()) {
                        a.raw_contents().len()
                    } else {
                        0
                    },
                    Some(Body::Array(a.raw_contents())),
                ),
                SubRecord::PrimitiveArray(a) => (
                    a.obj_id().id(),
                    18 + if targets.contains(&a.obj_id().id()) {
                        a.contents().len()
                    } else {
                        0
                    },
                    matches!(
                        a.primitive_type(),
                        jvm_hprof::heap_dump::PrimitiveArrayType::Byte
                    )
                    .then(|| Body::Bytes(a.contents())),
                ),
                SubRecord::Class(c) => {
                    let fields = c.instance_field_descriptors().count().saturating_mul(9);
                    let statics = c.static_fields().try_fold(0usize, |sum, field| {
                        let f =
                            field.map_err(|_| anyhow::anyhow!("Invalid producer static field"))?;
                        let value = if matches!(f.field_type(), FieldType::ObjectId) {
                            8
                        } else {
                            super::hprof_sizing::field_bytes(f.field_type()) as usize
                        };
                        Ok::<_, anyhow::Error>(sum.saturating_add(9 + value))
                    })?;
                    (
                        0,
                        71usize.saturating_add(fields).saturating_add(statics),
                        None,
                    )
                }
                _ => (0, 33, None),
            };
            if !budget.charge(bytes) {
                return Ok(None);
            }
            if targets.contains(&id) {
                let Some(body) = body else {
                    return Ok(None);
                };
                if found.insert(id, body).is_some() {
                    return Ok(None);
                }
                if found.len() == targets.len() {
                    return Ok(Some(found));
                }
            }
        }
    }
    Ok(None)
}
fn tag(kind: FieldType) -> u8 {
    match kind {
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
const LOADER_FIELDS: &[(&str, u8)] = &[
    ("parent", 2),
    ("name", 2),
    ("unnamedModule", 2),
    ("nameAndId", 2),
    ("parallelLockMap", 2),
    ("package2certs", 2),
    ("classes", 2),
    ("defaultDomain", 2),
    ("packages", 2),
    ("libraries", 2),
    ("assertionLock", 2),
    ("defaultAssertionStatus", 4),
    ("packageAssertionStatus", 2),
    ("classAssertionStatus", 2),
    ("classLoaderValueMap", 2),
];
const THREAD_FIELDS: &[(&str, u8)] = &[
    ("eetop", 11),
    ("tid", 11),
    ("name", 2),
    ("interrupted", 4),
    ("contextClassLoader", 2),
    ("inheritedAccessControlContext", 2),
    ("holder", 2),
    ("threadLocals", 2),
    ("inheritableThreadLocals", 2),
    ("scopedValueBindings", 2),
    ("interruptLock", 2),
    ("parkBlocker", 2),
    ("nioBlocker", 2),
    ("cont", 2),
    ("uncaughtExceptionHandler", 2),
    ("threadLocalRandomSeed", 11),
    ("threadLocalRandomProbe", 10),
    ("threadLocalRandomSecondarySeed", 10),
    ("container", 2),
    ("headStackableScopes", 2),
];

#[cfg(test)]
mod tests {
    use super::*;
    fn data(objects: &[(u64, usize)]) -> Vec<u8> {
        let mut data = b"JAVA PROFILE 1.0.2\0".to_vec();
        data.extend(8u32.to_be_bytes());
        data.extend(0u64.to_be_bytes());
        let mut heap = Vec::new();
        for &(id, len) in objects {
            heap.push(0x23);
            heap.extend(id.to_be_bytes());
            heap.extend(0u32.to_be_bytes());
            heap.extend((len as u32).to_be_bytes());
            heap.push(8);
            heap.resize(heap.len() + len, 0);
        }
        data.push(0x1c);
        data.extend(0u32.to_be_bytes());
        data.extend((heap.len() as u32).to_be_bytes());
        data.extend(heap);
        data
    }
    fn metadata(data: &[u8]) -> Metadata<'_> {
        let h = jvm_hprof::parse_hprof(data).unwrap();
        let mut m = Metadata::default();
        for r in h.records_iter() {
            if let Some(heap) = r.unwrap().as_heap_dump_segment() {
                let mut it = heap.unwrap().sub_records();
                let mut count = 0;
                loop {
                    if count == 0 {
                        m.checkpoint(it.clone());
                    }
                    let Some(s) = it.next() else { break };
                    m.observe(&s.unwrap());
                    count = (count + 1) % PAGE_RECORDS;
                }
            }
        }
        m
    }
    #[test]
    fn page_routing_preserves_unordered_ids_and_skips_unrelated_payload_bytes() {
        let input = data(&[(900, 1024 * 1024), (100, 1), (500, 1)]);
        let m = metadata(&input);
        let mut budget = Budget {
            bytes: MAX_PROBE_BYTES - 100,
            ..Default::default()
        };
        assert!(lookup(&m.pages, &[100, 500], &mut budget, &|| false)
            .unwrap()
            .is_some());
        assert!(!budget.exhausted);
        let mut budget = Budget {
            bytes: MAX_PROBE_BYTES - 100,
            ..Default::default()
        };
        assert!(lookup(&m.pages, &[900], &mut budget, &|| false)
            .unwrap()
            .is_none());
        assert!(budget.exhausted);
    }
    #[test]
    fn page_pruning_allows_late_targets_without_relaxing_record_limits() {
        let objects: Vec<_> = (0..PAGE_RECORDS + 1).map(|i| (i as u64 + 1, 0)).collect();
        let input = data(&objects);
        let m = metadata(&input);
        let mut budget = Budget {
            records: MAX_PROBE_RECORDS - 2,
            ..Default::default()
        };
        assert!(
            lookup(&m.pages, &[(PAGE_RECORDS + 1) as u64], &mut budget, &|| {
                false
            })
            .unwrap()
            .is_some()
        );
        assert_eq!(budget.records, MAX_PROBE_RECORDS - 1);
        let mut limited = Budget {
            records: MAX_PROBE_RECORDS,
            ..Default::default()
        };
        assert!(lookup(&m.pages, &[1], &mut limited, &|| false)
            .unwrap()
            .is_none());
        assert!(lookup(&m.pages, &[1], &mut Budget::default(), &|| true).is_err());
    }
    #[test]
    fn bounded_probe_work_and_ids_fail_closed() {
        let mut budget = Budget::default();
        assert!(budget.charge(MAX_PROBE_BYTES));
        assert!(!budget.charge(1));
        assert!(ids(&[0; 9], 8).is_none());
        assert!(ids(&vec![0; (MAX_TARGETS + 1) * 8], 8).is_none());
        assert_eq!(ids(&[0; 8], 8).unwrap(), Vec::<u64>::new());
        let mut budget = Budget::default();
        assert!(lookup(&[], &[0], &mut budget, &|| false).unwrap().is_none());
        assert!(lookup(&[], &[1], &mut budget, &|| true).is_err());
    }
}
