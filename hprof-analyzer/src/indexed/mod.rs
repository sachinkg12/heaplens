//! Indexed heap analysis backend.
//!
//! This module contains a memory-efficient indexed backend
//! with CSR graph storage, dominator index, class index,
//! and node store for fast heap dump analysis.
//!
//! For now it defines the `HeapAnalysis` trait that abstracts over backends,
//! and provides the impl for the existing `AnalysisState`.

pub mod types;
pub mod string_table;
pub mod class_index;
pub mod node_store;
pub mod edge_store;
mod column;
pub mod disk_edges;
mod edge_extract;
mod reference_plan;
mod bounded_edges;
mod parse_metadata;
pub mod storage;
pub mod progress;
mod stage_timer;
pub(crate) mod read_ahead;
mod cache_format;
mod compact_nodes;
mod sorted_runs;
pub mod deferred_records;
mod construction_nodes;
mod node_columns;
mod name_groups;
mod csr_replay;
mod memory_edges;
mod resource_plan;
mod resource_probe;
mod resource_lease;
mod cache_metadata;
mod cache_writer;
mod cache_digest;
mod structural_cache;
mod object_bodies;
pub mod parse;
pub mod dominator;
mod dominator_children;
pub mod waste;
pub mod analysis;

pub use types::HeapAnalysis;
pub use analysis::IndexedAnalysisState;
pub use analysis::Phase1AnalysisState;
