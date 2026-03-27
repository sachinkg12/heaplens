//! MAT-style indexed heap analysis backend.
//!
//! This module will eventually contain a memory-efficient indexed backend
//! that mirrors Eclipse MAT's architecture (dominator index, class index,
//! object index backed by memory-mapped files).
//!
//! For now it defines the `HeapAnalysis` trait that abstracts over backends,
//! and provides the impl for the existing `AnalysisState`.

mod types;
pub mod string_table;
pub mod class_index;
pub mod node_store;
pub mod edge_store;
pub mod parse;
pub mod dominator;
pub mod waste;
pub mod analysis;

pub use types::HeapAnalysis;
pub use analysis::IndexedAnalysisState;
