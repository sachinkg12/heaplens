//! Deferred waste analysis for the indexed backend.
//!
//! Computes waste metrics (duplicate strings, empty collections, over-allocated
//! arrays, boxed primitives) from raw data collected during parsing.
//! Called on-demand rather than eagerly during analysis.

use crate::waste::{compute_waste_analysis, WasteAnalysis, WasteRawData};

/// Computes waste analysis from raw data collected during indexed parsing.
///
/// This is a thin wrapper around `compute_waste_analysis` that provides
/// the entry point for the indexed backend's lazy waste computation.
pub fn compute_indexed_waste(raw: &WasteRawData, total_heap_size: u64) -> WasteAnalysis {
    compute_waste_analysis(raw, total_heap_size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_waste_data() {
        let raw = WasteRawData::new();
        let result = compute_indexed_waste(&raw, 1_000_000);

        assert_eq!(result.total_wasted_bytes, 0);
        assert_eq!(result.waste_percentage, 0.0);
        assert!(result.duplicate_strings.is_empty());
        assert!(result.empty_collections.is_empty());
        assert!(result.over_allocated_collections.is_empty());
        assert!(result.boxed_primitives.is_empty());
    }

    #[test]
    fn zero_heap_size() {
        let raw = WasteRawData::new();
        let result = compute_indexed_waste(&raw, 0);
        assert_eq!(result.waste_percentage, 0.0);
    }

    #[test]
    fn delegates_to_compute_waste_analysis() {
        // Verify that the function produces the same result as calling
        // compute_waste_analysis directly.
        let raw = WasteRawData::new();
        let direct = compute_waste_analysis(&raw, 100_000);
        let via_indexed = compute_indexed_waste(&raw, 100_000);

        assert_eq!(direct.total_wasted_bytes, via_indexed.total_wasted_bytes);
        assert_eq!(direct.waste_percentage, via_indexed.waste_percentage);
        assert_eq!(
            direct.duplicate_string_wasted_bytes,
            via_indexed.duplicate_string_wasted_bytes
        );
        assert_eq!(
            direct.empty_collection_wasted_bytes,
            via_indexed.empty_collection_wasted_bytes
        );
    }
}
