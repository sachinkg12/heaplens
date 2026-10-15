//! Shared strong-reference extraction for both memory and disk builders.
use super::{
    edge_store::label,
    parse::{DeferredEdgeData, DeferredInstance, Phase1Result},
};
use crate::graph_builder::{extract_object_references_fallback, extract_typed_references_named};
use anyhow::Result;

pub(crate) fn instance(
    di: &DeferredInstance,
    deferred: &DeferredEdgeData,
    phase: &Phase1Result,
    mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    // The VM keeps an object's runtime class alive independently of its fields.
    // Omitting this edge can make shared class statics appear exclusively owned.
    if let Some(class) = phase.node_store.index_of(di.class_obj_id) {
        emit(di.node_idx, class, label::RUNTIME_CLASS)?;
    }
    let fields = di
        .field_bytes
        .bytes(deferred.mapping.as_deref().map(|map| &map[..]))?;
    let mut failure = None;
    let mut reference = |ref_id, label| {
        if failure.is_some() {
            return;
        }
        if let Some(target) = phase.node_store.index_of(ref_id) {
            if let Err(error) = emit(di.node_idx, target, label) {
                failure = Some(error);
            }
        }
    };
    if let Some(layout) = phase.class_index.field_layout(di.class_obj_id) {
        extract_typed_references_named(fields, deferred.id_size, layout, |id, _, index| {
            if phase
                .class_index
                .is_strong_reference_field(di.class_obj_id, index)
            {
                reference(id, label::INSTANCE_FIELD);
            }
        });
    } else {
        extract_object_references_fallback(fields, deferred.id_size, |id| {
            reference(id, label::UNKNOWN)
        });
    }
    failure.map_or(Ok(()), Err)
}
pub(crate) fn structural(
    deferred: &DeferredEdgeData,
    phase: &Phase1Result,
    mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    for &id in &phase.gc_root_ids {
        if let Some(node) = phase.node_store.index_of(id) {
            emit(0, node, label::GC_ROOT)?;
        }
    }
    let width = match deferred.id_size {
        jvm_hprof::IdSize::U32 => 4,
        jvm_hprof::IdSize::U64 => 8,
    };
    for array in &deferred.deferred_arrays {
        if let Some(class) = phase.node_store.index_of(array.class_obj_id) {
            emit(array.node_idx, class, label::RUNTIME_CLASS)?;
        }
        for bytes in array
            .element_refs
            .bytes(deferred.mapping.as_deref().map(|map| &map[..]))?
            .chunks_exact(width)
        {
            let id = if width == 4 {
                u32::from_be_bytes(bytes.try_into()?) as u64
            } else {
                u64::from_be_bytes(bytes.try_into()?)
            };
            if id != 0 {
                if let Some(node) = phase.node_store.index_of(id) {
                    emit(array.node_idx, node, label::ARRAY_ELEMENT)?;
                }
            }
        }
    }
    // Primitive array records carry a type rather than a class object ID.
    // Only primitive types have a unique bootstrap runtime class by name.
    let primitive_classes: std::collections::HashMap<_, _> = deferred
        .class_name_map
        .iter()
        .filter(|(_, name)| {
            matches!(
                name.as_ref(),
                "boolean[]"
                    | "byte[]"
                    | "char[]"
                    | "short[]"
                    | "int[]"
                    | "float[]"
                    | "long[]"
                    | "double[]"
            )
        })
        .filter_map(|(&id, name)| {
            phase
                .node_store
                .index_of(id)
                .map(|node| (name.as_ref(), node))
        })
        .collect();
    let mirror = deferred
        .class_name_map
        .iter()
        .find(|(_, name)| name.as_ref() == "java.lang.Class")
        .and_then(|(&id, _)| phase.node_store.index_of(id));
    for (index, node) in phase.node_store.iter().enumerate() {
        let class = match node.node_type {
            super::node_store::NodeType::PrimitiveArray => {
                primitive_classes.get(node.class_name.as_ref()).copied()
            }
            super::node_store::NodeType::Class => mirror,
            _ => None,
        };
        if let Some(class) = class {
            emit(index as u32, class, label::RUNTIME_CLASS)?;
        }
    }
    for class in &deferred.deferred_class_edges {
        for (id, label) in [
            (class.super_class_id, label::SUPER_CLASS),
            (class.classloader_id, label::CLASS_LOADER),
            (class.signers_id, label::CLASS_SIGNERS),
            (class.protection_domain_id, label::PROTECTION_DOMAIN),
        ] {
            if let Some(node) = id.and_then(|id| phase.node_store.index_of(id)) {
                emit(class.class_node_idx, node, label)?;
            }
        }
        for &id in &class.static_field_refs {
            if let Some(node) = phase.node_store.index_of(id) {
                emit(class.class_node_idx, node, label::CLASS_STATIC)?;
            }
        }
    }
    Ok(())
}
