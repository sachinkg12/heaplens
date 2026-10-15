//! Estimated conventional JVM layout, independent of HPROF and graph storage.
//! Field placement, hidden VM fields and @Contended padding are not in HPROF.
//! Consequently this policy is an estimate, even when all widths are known.
use anyhow::{ensure, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ObjectLayout {
    pub(crate) word_bytes: u64,
    pub(crate) reference_bytes: u64,
    pub(crate) class_pointer_bytes: u64,
    pub(crate) alignment: u64,
}

/// Additive summary metadata: consumers must not interpret estimates as a
/// measurement of the producer VM. Old responses can omit this field.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct SizeModel {
    pub name: &'static str,
    pub estimated: bool,
    pub layout: ObjectLayout,
    pub layout_source: &'static str,
    pub incomplete_classes: usize,
    /// Retained byte estimates depend on graph policy as well as layout.
    /// Historical reports omit it, so comparisons can detect the change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_size_policy: Option<String>,
}

impl<'de> serde::Deserialize<'de> for SizeModel {
    fn deserialize<D: serde::Deserializer<'de>>(input: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        struct Owned { name: String, estimated: bool, layout: ObjectLayout, layout_source: String, incomplete_classes: usize,
            #[serde(default)] retained_size_policy: Option<String> }
        let value = <Owned as serde::Deserialize>::deserialize(input)?;
        let name = match value.name.as_str() { "legacy-payload-v0" => "legacy-payload-v0", "conventional-jvm-v1" => "conventional-jvm-v1", _ => return Err(serde::de::Error::custom("Unknown size model")) };
        let layout_source = match value.layout_source.as_str() { "legacy-payload" => "legacy-payload", "explicit" => "explicit", "address-inference-with-defaults" => "address-inference-with-defaults", _ => return Err(serde::de::Error::custom("Unknown layout source")) };
        let layout = ObjectLayout::new(value.layout.word_bytes, value.layout.reference_bytes, value.layout.class_pointer_bytes, value.layout.alignment).map_err(serde::de::Error::custom)?;
        Ok(Self { name, estimated: value.estimated, layout, layout_source, incomplete_classes: value.incomplete_classes,
            retained_size_policy: value.retained_size_policy })
    }
}

impl ObjectLayout {
    /// Explicit layout for callers that know the producer JVM options.
    pub fn new(
        word_bytes: u64,
        reference_bytes: u64,
        class_pointer_bytes: u64,
        alignment: u64,
    ) -> Result<Self> {
        ensure!(
            [4, 8].contains(&word_bytes)
                && [4, 8].contains(&reference_bytes)
                && [4, 8].contains(&class_pointer_bytes),
            "layout widths must be 4 or 8 bytes"
        );
        ensure!(
            reference_bytes <= word_bytes && class_pointer_bytes <= word_bytes,
            "reference widths cannot exceed machine word width"
        );
        ensure!(
            alignment.is_power_of_two() && (8..=256).contains(&alignment),
            "object alignment must be a power of two between 8 and 256"
        );
        Ok(Self {
            word_bytes,
            reference_bytes,
            class_pointer_bytes,
            alignment,
        })
    }

    pub fn reference_bytes(self) -> u64 {
        self.reference_bytes
    }
    pub fn object_header(self) -> u64 {
        self.word_bytes + self.class_pointer_bytes
    }
    pub(crate) fn round(value: u64, alignment: u64) -> Result<u64> {
        value
            .checked_add(alignment - 1)
            .map(|v| v & !(alignment - 1))
            .ok_or_else(|| anyhow::anyhow!("shallow size overflow"))
    }
    pub(crate) fn finish_instance(self, field_extent: u64) -> Result<u64> {
        Self::round(field_extent, self.alignment)
    }
    pub(crate) fn extend_instance(
        self,
        parent_extent: u64,
        primitive_bytes: u64,
        references: u64,
    ) -> Result<u64> {
        let size = references
            .checked_mul(self.reference_bytes)
            .and_then(|r| r.checked_add(primitive_bytes))
            .and_then(|fields| parent_extent.checked_add(fields))
            .ok_or_else(|| anyhow::anyhow!("instance size overflow"))?;
        // Field bytes are accumulated across the complete inheritance chain.
        // Rounding each superclass separately invents padding that modern
        // HotSpot can reuse for subclass fields (validated by the JVM oracle).
        Ok(size)
    }
    pub fn object_array(self, length: u32) -> Result<u64> {
        self.array(length, self.reference_bytes)
    }
    pub fn primitive_array(self, length: u32, element_bytes: u64) -> Result<u64> {
        ensure!(
            [1, 2, 4, 8].contains(&element_bytes),
            "invalid primitive width"
        );
        self.array(length, element_bytes)
    }
    fn array(self, length: u32, element_bytes: u64) -> Result<u64> {
        // Word-align the element base; wide elements also require 8-byte
        // alignment on 32-bit HotSpot. Array length always occupies 4 bytes.
        let header = Self::round(self.object_header() + 4, self.word_bytes.max(element_bytes))?;
        Self::round(header + u64::from(length) * element_bytes, self.alignment)
    }
    pub(crate) fn fallback_instance(self, serialized_bytes: usize) -> Result<u64> {
        self.finish_instance(
            self.object_header()
                .checked_add(serialized_bytes as u64)
                .ok_or_else(|| anyhow::anyhow!("instance size overflow"))?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independently_counted_layouts() {
        let compressed = ObjectLayout::new(8, 4, 4, 8).unwrap();
        assert_eq!(compressed.object_array(0).unwrap(), 16);
        assert_eq!(compressed.object_array(10).unwrap(), 56);
        assert_eq!(compressed.primitive_array(10, 1).unwrap(), 32);
        let mixed = ObjectLayout::new(8, 8, 4, 8).unwrap();
        assert_eq!(mixed.object_array(10).unwrap(), 96);
        assert_eq!(mixed.primitive_array(10, 1).unwrap(), 32);
        let uncompressed = ObjectLayout::new(8, 8, 8, 8).unwrap();
        assert_eq!(uncompressed.object_array(10).unwrap(), 104);
        assert_eq!(uncompressed.primitive_array(10, 1).unwrap(), 40);
    }
    #[test]
    fn large_arrays_do_not_wrap_at_four_gib() {
        let layout = ObjectLayout::new(8, 8, 8, 8).unwrap();
        assert_eq!(layout.primitive_array(u32::MAX, 8).unwrap(), 34_359_738_384);
        assert_eq!(layout.object_array(u32::MAX).unwrap(), 34_359_738_384);
    }
    #[test]
    fn generated_arrays_match_byte_counting_oracle() {
        for alignment in [8, 16, 32, 64, 128, 256] {
            let layout = ObjectLayout::new(8, 4, 4, alignment).unwrap();
            for length in 0..512 {
                for width in [1, 2, 4, 8] {
                    let mut expected = 16 + u64::from(length) * width;
                    while expected % alignment != 0 {
                        expected += 1;
                    }
                    assert_eq!(layout.primitive_array(length, width).unwrap(), expected);
                }
            }
        }
    }
    #[test]
    fn rejects_invalid_layouts_and_overflow() {
        for alignment in [0, 1, 7, 12, 512] {
            assert!(ObjectLayout::new(8, 4, 4, alignment).is_err());
        }
        assert!(ObjectLayout::new(4, 8, 4, 8).is_err());
        assert!(ObjectLayout::new(8, 3, 4, 8).is_err());
        assert!(ObjectLayout::round(u64::MAX, 8).is_err());
    }
    #[test]
    fn historical_models_remain_readable_without_inventing_graph_provenance() {
        let old = serde_json::json!({"name":"conventional-jvm-v1", "estimated":true,
            "layout":{"word_bytes":8,"reference_bytes":8,"class_pointer_bytes":4,"alignment":8},
            "layout_source":"explicit", "incomplete_classes":0});
        let mut model: SizeModel = serde_json::from_value(old.clone()).unwrap();
        assert!(model.retained_size_policy.is_none());
        assert_eq!(serde_json::to_value(&model).unwrap(), old);
        model.retained_size_policy = Some(crate::reference_strength::RETAINED_SIZE_POLICY.into());
        let current = serde_json::to_value(&model).unwrap();
        assert_ne!(old, current);
        assert_eq!(serde_json::from_value::<SizeModel>(current).unwrap(), model);
    }
}
