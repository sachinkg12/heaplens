//! Validate the embedded Instrumentation oracle in ShallowSizeCounterexample.
//! Usage: cargo run --release --example size_oracle -- dump.hprof [--allow-deltas]
use anyhow::{bail, Result};
use hprof_analyzer::indexed::parse::parse_indexed;
use hprof_analyzer::{build_graph, HprofLoader, NodeData};
use jvm_hprof::heap_dump::{FieldType, SubRecord};
use jvm_hprof::{parse_hprof, IdSize};
use std::collections::HashMap;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let data = HprofLoader::new(args.get(1).expect("HPROF path").into()).map_file()?;
    let hprof = parse_hprof(&data).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let id_width = if matches!(hprof.header().id_size(), IdSize::U32) {
        4
    } else {
        8
    };
    let mut strings = HashMap::new();
    let mut names = HashMap::new();
    let mut descriptors = HashMap::new();
    for record in hprof.records_iter() {
        let record = record.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        if let Some(s) = record.as_utf_8() {
            let s = s.map_err(|e| anyhow::anyhow!("{e:?}"))?;
            strings.insert(
                s.name_id().id(),
                String::from_utf8_lossy(s.text()).into_owned(),
            );
        }
        if let Some(c) = record.as_load_class() {
            let c = c.map_err(|e| anyhow::anyhow!("{e:?}"))?;
            names.insert(c.class_obj_id().id(), c.class_name_id().id());
        }
        if let Some(heap) = record.as_heap_dump_segment() {
            for sub in heap.map_err(|e| anyhow::anyhow!("{e:?}"))?.sub_records() {
                if let SubRecord::Class(c) = sub.map_err(|e| anyhow::anyhow!("{e:?}"))? {
                    let fields: Vec<_> = c
                        .instance_field_descriptors()
                        .map(|f| {
                            let f = f.unwrap();
                            (f.name_id().id(), f.field_type())
                        })
                        .collect();
                    descriptors.insert(c.obj_id().id(), fields);
                }
            }
        }
    }
    let sample_class = names
        .iter()
        .find(|(_, n)| {
            strings.get(n).map(String::as_str) == Some("ShallowSizeCounterexample$Sample")
        })
        .map(|(id, _)| *id)
        .ok_or_else(|| anyhow::anyhow!("No embedded oracle in this dump"))?;
    let indexed = parse_indexed(&data)?;
    let (legacy, _) = build_graph(&data)?;
    let mut tested = 0;
    let mut deltas = 0;
    for record in hprof.records_iter() {
        if let Some(heap) = record.unwrap().as_heap_dump_segment() {
            for sub in heap.unwrap().sub_records() {
                if let SubRecord::Instance(instance) = sub.unwrap() {
                    if instance.class_obj_id().id() != sample_class {
                        continue;
                    }
                    let mut offset = 0;
                    let mut expected = 0;
                    let mut target = 0;
                    for (name_id, kind) in &descriptors[&sample_class] {
                        let width = match kind {
                            FieldType::ObjectId => id_width,
                            FieldType::Long => 8,
                            _ => bail!("unexpected oracle field"),
                        };
                        let value = instance.fields()[offset..offset + width]
                            .iter()
                            .fold(0u64, |v, b| (v << 8) | *b as u64);
                        match strings[name_id].as_str() {
                            "value" => target = value,
                            "expectedSize" => expected = value,
                            _ => {}
                        }
                        offset += width;
                    }
                    let node = indexed.node_store.get_by_id(target).unwrap();
                    let legacy_size = match legacy.graph()[legacy.id_to_node()[&target]] {
                        NodeData::Instance { size, .. } | NodeData::Array { size, .. } => {
                            size as u64
                        }
                        _ => bail!("oracle target is not an object"),
                    };
                    assert_eq!(
                        node.shallow_size as u64, legacy_size,
                        "backend mismatch at {target:x}"
                    );
                    tested += 1;
                    if expected != node.shallow_size as u64 {
                        deltas += 1;
                        println!(
                            "DELTA 0x{target:x} {} expected={expected} actual={}",
                            node.class_name, node.shallow_size
                        );
                    }
                }
            }
        }
    }
    println!(
        "ORACLE samples={tested} mismatches={deltas} total_heap={} backend_parity=true",
        indexed.summary.total_heap_size
    );
    if tested == 0 || (deltas > 0 && !args.iter().any(|a| a == "--allow-deltas")) {
        bail!("shallow-size oracle mismatch");
    }
    Ok(())
}
