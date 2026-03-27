//! Core trait abstracting over heap analysis backends.
//!
//! `HeapAnalysis` defines the read-only query interface that the RPC/MCP
//! layer uses to service client requests. The existing `AnalysisState`
//! implements this trait directly, allowing us to swap in an indexed
//! (MAT-style) backend later without touching the server code.

use std::path::Path;

use crate::heapql::{HeapQlError, QueryResult};
use crate::waste::WasteAnalysis;
use crate::{ClassHistogramEntry, FieldInfo, HeapSummary, LeakSuspect, ObjectReport};

/// Read-only query interface over a fully-analysed heap dump.
///
/// Every method takes `&self` — the analysis state is immutable once built.
/// Implementations must be `Send + Sync` so the trait object can live behind
/// an `Arc` in the async server.
pub trait HeapAnalysis: Send + Sync {
    /// Returns children of the given object in the dominator tree.
    fn get_children(&self, object_id: u64) -> Option<Vec<ObjectReport>>;

    /// Returns the heap summary (sizes, counts, version info).
    fn get_summary(&self) -> &HeapSummary;

    /// Returns the class histogram sorted by retained size.
    fn get_class_histogram(&self) -> &[ClassHistogramEntry];

    /// Returns detected leak suspects.
    fn get_leak_suspects(&self) -> &[LeakSuspect];

    /// Returns waste analysis (duplicate strings, empty collections, etc.).
    fn get_waste_analysis(&self) -> &WasteAnalysis;

    /// Returns the top objects via a BFS of the dominator tree.
    fn get_top_layers(&self, max_depth: usize, max_nodes: usize) -> Vec<ObjectReport>;

    /// Inspects all fields of an object, re-mapping the HPROF file from disk.
    fn inspect_object(&self, hprof_path: &Path, object_id: u64) -> Option<Vec<FieldInfo>>;

    /// Inspects all fields of an object using pre-loaded HPROF bytes.
    fn inspect_object_bytes(&self, hprof_bytes: &[u8], object_id: u64) -> Option<Vec<FieldInfo>>;

    /// Executes a HeapQL query and returns the full result set.
    fn execute_query(&self, query_str: &str) -> Result<QueryResult, HeapQlError>;

    /// Executes a HeapQL query with server-side pagination.
    fn execute_query_paged(
        &self,
        query_str: &str,
        page: u64,
        page_size: u64,
    ) -> Result<QueryResult, HeapQlError>;
}

// ---------------------------------------------------------------------------
// Blanket impl for AnalysisState
// ---------------------------------------------------------------------------

impl HeapAnalysis for crate::AnalysisState {
    fn get_children(&self, object_id: u64) -> Option<Vec<ObjectReport>> {
        self.get_children(object_id)
    }

    fn get_summary(&self) -> &HeapSummary {
        &self.summary
    }

    fn get_class_histogram(&self) -> &[ClassHistogramEntry] {
        &self.class_histogram
    }

    fn get_leak_suspects(&self) -> &[LeakSuspect] {
        &self.leak_suspects
    }

    fn get_waste_analysis(&self) -> &WasteAnalysis {
        &self.waste_analysis
    }

    fn get_top_layers(&self, max_depth: usize, max_nodes: usize) -> Vec<ObjectReport> {
        self.get_top_layers(max_depth, max_nodes)
    }

    fn inspect_object(&self, hprof_path: &Path, object_id: u64) -> Option<Vec<FieldInfo>> {
        self.inspect_object(hprof_path, object_id)
    }

    fn inspect_object_bytes(&self, hprof_bytes: &[u8], object_id: u64) -> Option<Vec<FieldInfo>> {
        self.inspect_object_bytes(hprof_bytes, object_id)
    }

    fn execute_query(&self, query_str: &str) -> Result<QueryResult, HeapQlError> {
        self.execute_query(query_str)
    }

    fn execute_query_paged(
        &self,
        query_str: &str,
        page: u64,
        page_size: u64,
    ) -> Result<QueryResult, HeapQlError> {
        self.execute_query_paged(query_str, page, page_size)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::build_test_state;

    /// Verifies that AnalysisState can be used through &dyn HeapAnalysis
    /// and that results match direct method calls.
    #[test]
    fn trait_object_delegates_correctly() {
        let state = build_test_state();
        let dyn_ref: &dyn HeapAnalysis = &state;

        // get_summary
        assert_eq!(dyn_ref.get_summary(), &state.summary);

        // get_class_histogram
        assert_eq!(dyn_ref.get_class_histogram().len(), state.class_histogram.len());
        assert_eq!(dyn_ref.get_class_histogram()[0].class_name, state.class_histogram[0].class_name);

        // get_leak_suspects
        assert_eq!(dyn_ref.get_leak_suspects().len(), state.leak_suspects.len());
        assert_eq!(
            dyn_ref.get_leak_suspects()[0].object_id,
            state.leak_suspects[0].object_id
        );

        // get_waste_analysis
        assert_eq!(
            dyn_ref.get_waste_analysis().total_wasted_bytes,
            state.waste_analysis.total_wasted_bytes
        );

        // get_children — results from trait must match direct calls
        for oid in [0u64, 100, 200, 400, 99999] {
            let direct = state.get_children(oid);
            let via_trait = dyn_ref.get_children(oid);
            match (&direct, &via_trait) {
                (Some(d), Some(t)) => assert_eq!(d.len(), t.len(), "children count mismatch for oid={}", oid),
                (None, None) => {}
                _ => panic!("get_children({}) mismatch: direct={:?} trait={:?}", oid, direct.is_some(), via_trait.is_some()),
            }
        }

        // get_top_layers
        let layers_direct = state.get_top_layers(3, 100);
        let layers_trait = dyn_ref.get_top_layers(3, 100);
        assert_eq!(layers_direct.len(), layers_trait.len());

        // execute_query
        let q = "SELECT * FROM class_histogram LIMIT 2";
        let result_direct = state.execute_query(q).unwrap();
        let result_trait = dyn_ref.execute_query(q).unwrap();
        assert_eq!(result_direct.rows.len(), result_trait.rows.len());

        // execute_query_paged
        let result_paged = dyn_ref.execute_query_paged(q, 1, 1).unwrap();
        assert!(result_paged.page.is_some());
    }
}
