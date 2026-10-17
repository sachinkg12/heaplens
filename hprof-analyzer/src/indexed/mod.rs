//! Indexed heap analysis backend.
//!
//! This module contains a memory-efficient indexed backend
//! with CSR graph storage, dominator index, class index,
//! and node store for fast heap dump analysis.
//!
//! For now it defines the `HeapAnalysis` trait that abstracts over backends,
//! and provides the impl for the existing `AnalysisState`.

pub mod analysis;
pub(crate) mod array_catalog;
mod bounded_edges;
mod cache_digest;
mod cache_format;
mod cache_metadata;
mod cache_writer;
pub mod class_index;
mod column;
mod compact_nodes;
mod construction_nodes;
mod csr_replay;
pub mod deferred_records;
pub mod disk_edges;
pub mod dominator;
mod dominator_children;
mod edge_extract;
#[cfg(test)]
mod edge_sort;
pub mod edge_store;
mod memory_edges;
mod name_groups;
mod node_columns;
pub mod node_store;
mod object_bodies;
mod packed_table;
pub mod parse;
mod parse_metadata;
pub mod progress;
pub(crate) mod read_ahead;
mod reference_batch;
mod reference_plan;
mod resource_lease;
mod resource_plan;
mod resource_probe;
mod run_budget;
mod sorted_runs;
mod stage_timer;
pub mod storage;
pub mod string_table;
mod structural_cache;
pub mod types;
pub mod waste;

pub use analysis::IndexedAnalysisState;
pub use analysis::Phase1AnalysisState;
pub use types::HeapAnalysis;
