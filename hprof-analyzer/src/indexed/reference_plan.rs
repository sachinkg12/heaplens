//! Strong reference offsets in HPROF serialized bodies, not JVM memory layouts.
//! Plans are per full class ID; inherited field strength is resolved beforehand.
use jvm_hprof::{heap_dump::FieldType, IdSize};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub(crate) struct ReferencePlans {
    offsets32: Vec<usize>,
    offsets64: Vec<usize>,
}
impl ReferencePlans {
    pub fn compile(layout: &[(Arc<str>, FieldType)], strong: impl Fn(usize) -> bool) -> Self {
        let compile = |width| {
            let mut offset = 0usize;
            let mut offsets = Vec::new();
            for (index, (_, kind)) in layout.iter().enumerate() {
                let Some(end) = offset.checked_add(crate::graph_builder::field_type_size(kind, width)) else { break; };
                if matches!(kind, FieldType::ObjectId) && strong(index) { offsets.push(offset); }
                offset = end;
            }
            offsets
        };
        Self { offsets32: compile(IdSize::U32), offsets64: compile(IdSize::U64) }
    }
    pub fn references(&self, data: &[u8], width: IdSize, mut reference: impl FnMut(u64)) {
        match width {
            IdSize::U32 => for &at in &self.offsets32 {
                let Some(bytes) = data.get(at..at + 4) else { break; };
                let id = u32::from_be_bytes(bytes.try_into().unwrap()) as u64;
                if id != 0 { reference(id); }
            },
            IdSize::U64 => for &at in &self.offsets64 {
                let Some(bytes) = data.get(at..at + 8) else { break; };
                let id = u64::from_be_bytes(bytes.try_into().unwrap());
                if id != 0 { reference(id); }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_plans_match_typed_decoder_for_both_widths_nulls_and_every_truncation() {
        use FieldType::*;
        let kinds = [ObjectId, Byte, Long, ObjectId, Boolean, Char, Double, Float, Int, Short];
        let mut seed = 0x68c2_7001u64;
        for case in 0..300 {
            let layout: Vec<_> = (0..case % 41).map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (Arc::from("field"), kinds[(seed >> 32) as usize % kinds.len()])
            }).collect();
            let strong = |i| (i + case) % 3 != 0;
            let plans = ReferencePlans::compile(&layout, strong);
            let bytes: Vec<_> = (0..400).map(|i| if case % 3 == 0 { 0 } else { (i * 71 + case) as u8 }).collect();
            for width in [IdSize::U32, IdSize::U64] {
                for len in 0..=bytes.len() {
                    let mut expected = Vec::new();
                    crate::graph_builder::extract_typed_references_named(&bytes[..len], width, &layout, |id, _, index| {
                        if strong(index) { expected.push(id); }
                    });
                    let mut actual = Vec::new();
                    plans.references(&bytes[..len], width, |id| actual.push(id));
                    assert_eq!(actual, expected, "case={case}, bytes={len}, width={width:?}");
                }
            }
        }
    }
}
