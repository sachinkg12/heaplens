//! Graph construction from HPROF binary data.
//!
//! Parses the HPROF file in 3 passes:
//! - Pass 0: Build string table, class name map, class nodes
//! - Pass 1: Identify all nodes (instances, arrays, GC roots)
//! - Pass 2: Add edges (references) and collect waste data

use anyhow::Result;
use jvm_hprof::{parse_hprof, RecordTag, IdSize};
use petgraph::{Graph, Directed, graph::NodeIndex};
use std::collections::HashMap;
use std::sync::Arc;

use crate::{NodeData, EdgeLabel, HeapGraph, HeapSummary};
use crate::waste::{
    WasteRawData, StringInstanceInfo, BackingArrayInfo, EmptyCollectionInfo,
    OverAllocatedCollectionInfo, BoxedPrimitiveInfo, hash_bytes, extract_nth_field_of_type,
};

/// Converts a JVM internal class name to Java format.
///
/// Examples:
/// - `java/lang/String` → `java.lang.String`
/// - `[B` → `byte[]`
/// - `[Ljava/lang/Object;` → `java.lang.Object[]`
/// - `[[I` → `int[][]`
pub(crate) fn convert_jvm_class_name(name: &str) -> String {
    if name.starts_with('[') {
        let mut depth = 0;
        let mut chars = name.chars();
        while chars.as_str().starts_with('[') {
            depth += 1;
            chars.next();
        }
        let rest = chars.as_str();
        let base = match rest {
            "B" => "byte".to_string(),
            "C" => "char".to_string(),
            "D" => "double".to_string(),
            "F" => "float".to_string(),
            "I" => "int".to_string(),
            "J" => "long".to_string(),
            "S" => "short".to_string(),
            "Z" => "boolean".to_string(),
            s if s.starts_with('L') && s.ends_with(';') => {
                s[1..s.len()-1].replace('/', ".")
            }
            other => other.replace('/', "."),
        };
        format!("{}{}", base, "[]".repeat(depth))
    } else {
        name.replace('/', ".")
    }
}

/// Returns the byte size of a field type in the HPROF binary format.
pub(crate) fn field_type_size(ft: &jvm_hprof::heap_dump::FieldType, id_size: IdSize) -> usize {
    use jvm_hprof::heap_dump::FieldType;
    match ft {
        FieldType::ObjectId => match id_size { IdSize::U32 => 4, IdSize::U64 => 8 },
        FieldType::Boolean | FieldType::Byte => 1,
        FieldType::Char | FieldType::Short => 2,
        FieldType::Int | FieldType::Float => 4,
        FieldType::Long | FieldType::Double => 8,
    }
}

/// Extracts just the FieldType values from a named field layout.
pub(crate) fn types_only(layout: &[(Arc<str>, jvm_hprof::heap_dump::FieldType)]) -> Vec<jvm_hprof::heap_dump::FieldType> {
    layout.iter().map(|(_, ft)| *ft).collect()
}

/// Extracts object references from instance field data using typed field descriptors,
/// also yielding the field name for each reference.
pub(crate) fn extract_typed_references_named<F>(
    data: &[u8],
    id_size: IdSize,
    field_layout: &[(Arc<str>, jvm_hprof::heap_dump::FieldType)],
    mut callback: F,
)
where
    F: FnMut(u64, &Arc<str>),
{
    let mut offset = 0;
    for (name, ft) in field_layout {
        let size = field_type_size(ft, id_size);
        if offset + size > data.len() {
            break;
        }
        if matches!(ft, jvm_hprof::heap_dump::FieldType::ObjectId) {
            let id = match id_size {
                IdSize::U32 => {
                    u32::from_be_bytes([
                        data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                    ]) as u64
                }
                IdSize::U64 => {
                    u64::from_be_bytes([
                        data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                        data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
                    ])
                }
            };
            if id != 0 {
                callback(id, name);
            }
        }
        offset += size;
    }
}

/// Fallback: brute-force extraction of potential object references from byte data.
pub(crate) fn extract_object_references_fallback<F>(data: &[u8], id_size: IdSize, mut callback: F)
where
    F: FnMut(u64),
{
    let id_bytes = match id_size {
        IdSize::U32 => 4,
        IdSize::U64 => 8,
    };
    for chunk in data.chunks_exact(id_bytes) {
        let id = match id_size {
            IdSize::U32 => {
                u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as u64
            }
            IdSize::U64 => {
                u64::from_be_bytes([
                    chunk[0], chunk[1], chunk[2], chunk[3],
                    chunk[4], chunk[5], chunk[6], chunk[7],
                ])
            }
        };
        if id != 0 {
            callback(id);
        }
    }
}

