//! Shared strong-reference extraction for both memory and disk builders.
use super::{
    edge_store::label,
    parse::{DeferredEdgeData, DeferredInstance, Phase1Result},
};
use crate::graph_builder::extract_object_references_fallback;
use anyhow::Result;

pub(crate) fn instance(
    di: &DeferredInstance,
    deferred: &DeferredEdgeData,
    phase: &Phase1Result,
    emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    instance_with_lookup(
        di,
        deferred,
        phase,
        |id| phase.node_store.index_of(id),
        emit,
    )
}
pub(crate) fn count_instance(
    di: &DeferredInstance,
    deferred: &DeferredEdgeData,
    phase: &Phase1Result,
    mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    // Count potential references without resolving every ID twice. Missing
    // targets leave unused slots that the CSR builder compacts away.
    let mut degree = 0u32;
    instance_with_lookup(
        di,
        deferred,
        phase,
        |_| Some(0),
        |_, _, _| {
            degree = degree
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Reference degree overflow"))?;
            Ok(())
        },
    )?;
    // One bounded-queue item per object, not one per potential reference.
    if degree > 0 {
        emit(di.node_idx, degree, label::UNKNOWN)?;
    }
    Ok(())
}
fn instance_with_lookup(
    di: &DeferredInstance,
    deferred: &DeferredEdgeData,
    phase: &Phase1Result,
    lookup: impl Fn(u64) -> Option<u32>,
    mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    // The VM keeps an object's runtime class alive independently of its fields.
    // Omitting this edge can make shared class statics appear exclusively owned.
    if let Some(class) = lookup(di.class_obj_id) {
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
        if let Some(target) = lookup(ref_id) {
            if let Err(error) = emit(di.node_idx, target, label) {
                failure = Some(error);
            }
        }
    };
    if let Some(plan) = phase.class_index.reference_plan(di.class_obj_id) {
        plan.references(fields, deferred.id_size, |id| reference(id, label::INSTANCE_FIELD));
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
    emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    structural_with_lookup(deferred, phase, |id| phase.node_store.index_of(id), emit)
}
pub(crate) fn count_structural(
    deferred: &DeferredEdgeData,
    phase: &Phase1Result,
    mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    structural_with_lookup(
        deferred,
        phase,
        |_| Some(0),
        |src, _, label| emit(src, 1, label),
    )
}
fn structural_with_lookup(
    deferred: &DeferredEdgeData,
    phase: &Phase1Result,
    lookup: impl Fn(u64) -> Option<u32>,
    mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
) -> Result<()> {
    for &id in &phase.gc_root_ids {
        if let Some(node) = lookup(id) {
            emit(0, node, label::GC_ROOT)?;
        }
    }
    let width = match deferred.id_size {
        jvm_hprof::IdSize::U32 => 4,
        jvm_hprof::IdSize::U64 => 8,
    };
    for array in deferred.deferred_arrays.iter() {
        if let Some(class) = lookup(array.class_obj_id) {
            emit(array.node_idx, class, label::RUNTIME_CLASS)?;
        }
        for bytes in array
            .field_bytes
            .bytes(deferred.mapping.as_deref().map(|map| &map[..]))?
            .chunks_exact(width)
        {
            let id = if width == 4 {
                u32::from_be_bytes(bytes.try_into()?) as u64
            } else {
                u64::from_be_bytes(bytes.try_into()?)
            };
            if id != 0 {
                if let Some(node) = lookup(id) {
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
        .filter_map(|(&id, name)| lookup(id).map(|node| (name.as_ref(), node)))
        .collect();
    let mirror = deferred
        .class_name_map
        .iter()
        .find(|(_, name)| name.as_ref() == "java.lang.Class")
        .and_then(|(&id, _)| lookup(id));
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
            if let Some(node) = id.and_then(&lookup) {
                emit(class.class_node_idx, node, label)?;
            }
        }
        for &id in &class.static_field_refs {
            if let Some(node) = lookup(id) {
                emit(class.class_node_idx, node, label::CLASS_STATIC)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Optional real-capture differential check; ordinary CI uses byte fixtures.
    #[test]
    #[ignore = "requires HEAPLENS_ORACLE_DUMP pointing at a local capture"]
    fn every_edge_label_parent_and_retained_size_matches_the_prior_decoder() {
        let path = std::env::var_os("HEAPLENS_ORACLE_DUMP").expect("HEAPLENS_ORACLE_DUMP");
        let mapping = crate::HprofLoader::new(path.into()).map_file().unwrap();
        let (phase, deferred) = super::super::parse::parse_indexed_phase1_mapped(Arc::new(mapping), None).unwrap();
        // The compact body index is also used by inspection/queries, not just
        // retained reports. Compare every class ID and raw field slice.
        {
            let bodies = super::super::object_bodies::ObjectBodies::memory_catalog(&deferred.deferred_instances).unwrap();
            let input = &deferred.mapping.as_ref().unwrap()[..];
            for record in deferred.deferred_instances.iter() {
                assert_eq!(bodies.fields(record.node_idx, input),
                    Some((record.class_obj_id, record.field_bytes.bytes(Some(input)).unwrap())));
            }
        }
        let mut oracle = super::super::edge_store::EdgeBuilder::new();
        for di in deferred.deferred_instances.iter() {
            if let Some(class) = phase.node_store.index_of(di.class_obj_id) { oracle.add_edge(di.node_idx, class, label::RUNTIME_CLASS); }
            let fields = di.field_bytes.bytes(deferred.mapping.as_deref().map(|m| &m[..])).unwrap();
            let mut reference = |id, edge_label| {
                if let Some(target) = phase.node_store.index_of(id) { oracle.add_edge(di.node_idx, target, edge_label); }
            };
            if let Some(layout) = phase.class_index.field_layout(di.class_obj_id) {
                crate::graph_builder::extract_typed_references_named(fields, deferred.id_size, layout, |id, _, index| {
                    if phase.class_index.is_strong_reference_field(di.class_obj_id, index) { reference(id, label::INSTANCE_FIELD); }
                });
            } else {
                crate::graph_builder::extract_object_references_fallback(fields, deferred.id_size, |id| reference(id, label::UNKNOWN));
            }
        }
        structural(&deferred, &phase, |s, t, l| { oracle.add_edge(s, t, l); Ok(()) }).unwrap();
        let oracle = oracle.build(phase.node_store.len());
        let actual = super::super::parse::parse_indexed_phase2(&phase, deferred).unwrap();
        for node in 0..phase.node_store.len() as u32 {
            assert_eq!(actual.edge_store.neighbor_labels(node), oracle.neighbor_labels(node), "outgoing ID={:x}", phase.node_store.id_at(node));
            assert_eq!(actual.edge_store.reverse_neighbors(node), oracle.reverse_neighbors(node), "incoming ID={:x}", phase.node_store.id_at(node));
        }
        let expected_dom = super::super::dominator::compute_dominators(&phase.node_store, &oracle, &[]);
        let actual_dom = super::super::dominator::compute_dominators(&phase.node_store, &actual.edge_store, &[]);
        assert_eq!(actual_dom.dominator_parent, expected_dom.dominator_parent);
        assert_eq!(actual_dom.retained_sizes, expected_dom.retained_sizes);
        assert_eq!(actual_dom.unreachable_shallow_size, expected_dom.unreachable_shallow_size);
    }
    use std::sync::Arc;
}
