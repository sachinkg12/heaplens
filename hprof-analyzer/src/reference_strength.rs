//! Classification of Java reference fields for strong-reachability analysis.
//!
//! HPROF serializes `java.lang.ref.Reference.referent` like an ordinary object
//! field even though the JVM does not treat that edge as strongly retaining.
//! Keeping this policy separate lets every graph backend apply the same rule
//! without embedding Java-library class-name checks in parser loops.

/// Whether an instance field keeps its target strongly reachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReferenceStrength {
    Strong,
    NonStrong,
}

impl ReferenceStrength {
    pub(crate) fn is_strong(self) -> bool {
        matches!(self, Self::Strong)
    }
}

/// Classifies a field using the class that declares it, not the runtime class
/// of the containing object. This distinction preserves an unrelated strong
/// field named `referent`, including one that hides the inherited JDK field.
pub(crate) fn classify_instance_field(
    declaring_class_name: &str,
    field_name: &str,
) -> ReferenceStrength {
    if declaring_class_name == "java.lang.ref.Reference" && field_name == "referent" {
        ReferenceStrength::NonStrong
    } else {
        ReferenceStrength::Strong
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REFERENCE_CLASS_ID: u32 = 0x100;
    const WEAK_REFERENCE_CLASS_ID: u32 = 0x101;
    const HOLDER_CLASS_ID: u32 = 0x102;
    const PAYLOAD_CLASS_ID: u32 = 0x103;
    const WEAK_REFERENCE_ID: u32 = 0x200;
    const HOLDER_ID: u32 = 0x201;
    const PAYLOAD_ID: u32 = 0x300;

    fn push_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn push_record(hprof: &mut Vec<u8>, tag: u8, body: &[u8]) {
        hprof.push(tag);
        push_u32(hprof, 0);
        push_u32(hprof, body.len() as u32);
        hprof.extend_from_slice(body);
    }

    fn push_utf8_record(hprof: &mut Vec<u8>, id: u32, text: &str) {
        let mut body = Vec::new();
        push_u32(&mut body, id);
        body.extend_from_slice(text.as_bytes());
        push_record(hprof, 0x01, &body);
    }

    fn push_load_class_record(
        hprof: &mut Vec<u8>,
        serial: u32,
        class_id: u32,
        name_id: u32,
    ) {
        let mut body = Vec::new();
        push_u32(&mut body, serial);
        push_u32(&mut body, class_id);
        push_u32(&mut body, 0);
        push_u32(&mut body, name_id);
        push_record(hprof, 0x02, &body);
    }

    fn push_class_dump(
        heap: &mut Vec<u8>,
        class_id: u32,
        super_class_id: u32,
        fields: &[(u32, u8)],
    ) {
        heap.push(0x20);
        push_u32(heap, class_id);
        push_u32(heap, 0);
        push_u32(heap, super_class_id);
        for _ in 0..5 {
            push_u32(heap, 0);
        }
        push_u32(heap, 16);
        push_u16(heap, 0);
        push_u16(heap, 0);
        push_u16(heap, fields.len() as u16);
        for &(name_id, field_type) in fields {
            push_u32(heap, name_id);
            heap.push(field_type);
        }
    }

    fn push_instance_dump(
        heap: &mut Vec<u8>,
        object_id: u32,
        class_id: u32,
        fields: &[u8],
    ) {
        heap.push(0x21);
        push_u32(heap, object_id);
        push_u32(heap, 0);
        push_u32(heap, class_id);
        push_u32(heap, fields.len() as u32);
        heap.extend_from_slice(fields);
    }

    /// Independent, minimal HPROF oracle: the inherited JDK referent and an
    /// unrelated user field share the same name and point at the same payload.
    fn reference_field_hprof() -> Vec<u8> {
        let mut hprof = b"JAVA PROFILE 1.0.2\0".to_vec();
        push_u32(&mut hprof, 4);
        hprof.extend_from_slice(&0u64.to_be_bytes());

        let names = [
            (1, "java/lang/ref/Reference"),
            (2, "java/lang/ref/WeakReference"),
            (3, "example/Holder"),
            (4, "example/Payload"),
            (5, "referent"),
        ];
        for (id, name) in names {
            push_utf8_record(&mut hprof, id, name);
        }
        for (serial, class_id, name_id) in [
            (1, REFERENCE_CLASS_ID, 1),
            (2, WEAK_REFERENCE_CLASS_ID, 2),
            (3, HOLDER_CLASS_ID, 3),
            (4, PAYLOAD_CLASS_ID, 4),
        ] {
            push_load_class_record(&mut hprof, serial, class_id, name_id);
        }

        let mut heap = Vec::new();
        push_class_dump(&mut heap, REFERENCE_CLASS_ID, 0, &[(5, 0x02)]);
        push_class_dump(
            &mut heap,
            WEAK_REFERENCE_CLASS_ID,
            REFERENCE_CLASS_ID,
            &[],
        );
        push_class_dump(&mut heap, HOLDER_CLASS_ID, 0, &[(5, 0x02)]);
        push_class_dump(&mut heap, PAYLOAD_CLASS_ID, 0, &[]);

        for root_id in [WEAK_REFERENCE_ID, HOLDER_ID] {
            heap.push(0xff);
            push_u32(&mut heap, root_id);
        }

        let payload_field = PAYLOAD_ID.to_be_bytes();
        push_instance_dump(
            &mut heap,
            WEAK_REFERENCE_ID,
            WEAK_REFERENCE_CLASS_ID,
            &payload_field,
        );
        push_instance_dump(&mut heap, HOLDER_ID, HOLDER_CLASS_ID, &payload_field);
        push_instance_dump(&mut heap, PAYLOAD_ID, PAYLOAD_CLASS_ID, &[]);
        push_record(&mut hprof, 0x1c, &heap);
        push_record(&mut hprof, 0x2c, &[]);
        hprof
    }

    #[test]
    fn classifies_only_the_jdk_reference_referent_as_non_strong() {
        assert_eq!(
            classify_instance_field("java.lang.ref.Reference", "referent"),
            ReferenceStrength::NonStrong
        );
        assert_eq!(
            classify_instance_field("java.lang.ref.Reference", "queue"),
            ReferenceStrength::Strong
        );
        assert_eq!(
            classify_instance_field("example.Reference", "referent"),
            ReferenceStrength::Strong
        );
        assert_eq!(
            classify_instance_field("java.lang.ref.Reference", "Referent"),
            ReferenceStrength::Strong
        );
    }

    #[test]
    fn legacy_parser_excludes_jdk_referent_but_keeps_same_named_user_field() {
        let (graph, _) = crate::build_graph(&reference_field_hprof()).unwrap();
        let reference = graph.id_to_node()[&(WEAK_REFERENCE_ID as u64)];
        let holder = graph.id_to_node()[&(HOLDER_ID as u64)];
        let payload = graph.id_to_node()[&(PAYLOAD_ID as u64)];

        assert!(graph.graph().find_edge(reference, payload).is_none());
        assert!(graph.graph().find_edge(holder, payload).is_some());
    }

    #[test]
    fn indexed_parser_excludes_jdk_referent_but_keeps_same_named_user_field() {
        let parsed = crate::indexed::parse::parse_indexed(&reference_field_hprof()).unwrap();
        let reference = parsed.node_store.index_of(WEAK_REFERENCE_ID as u64).unwrap();
        let holder = parsed.node_store.index_of(HOLDER_ID as u64).unwrap();
        let payload = parsed.node_store.index_of(PAYLOAD_ID as u64).unwrap();

        assert!(!parsed.edge_store.neighbors(reference).contains(&payload));
        assert!(parsed.edge_store.neighbors(holder).contains(&payload));
    }

    #[test]
    fn field_inspection_still_exposes_the_raw_referent() {
        use crate::indexed::analysis::IndexedAnalysisState;
        use crate::indexed::types::HeapAnalysis;

        let hprof = reference_field_hprof();

        let (graph, waste) = crate::build_graph(&hprof).unwrap();
        let (_, legacy) =
            crate::dominator::calculate_dominators_with_state(graph, waste).unwrap();
        let legacy_fields = legacy
            .inspect_object_bytes(&hprof, WEAK_REFERENCE_ID as u64)
            .unwrap();

        let indexed = IndexedAnalysisState::from_parse_result(
            crate::indexed::parse::parse_indexed(&hprof).unwrap(),
        )
        .unwrap();
        let indexed_fields =
            HeapAnalysis::inspect_object_bytes(&indexed, &hprof, WEAK_REFERENCE_ID as u64)
                .unwrap();

        for fields in [&legacy_fields, &indexed_fields] {
            assert!(fields.iter().any(|field| {
                field.name == "referent"
                    && field.field_type == "ref"
                    && field.ref_object_id == Some(PAYLOAD_ID as u64)
            }));
        }
    }
}
