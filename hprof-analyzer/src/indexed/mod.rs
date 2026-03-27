//! MAT-style indexed heap analysis backend.
//!
//! This module will eventually contain a memory-efficient indexed backend
//! that mirrors Eclipse MAT's architecture (dominator index, class index,
//! object index backed by memory-mapped files).
//!
//! For now it defines the `HeapAnalysis` trait that abstracts over backends,
//! and provides the impl for the existing `AnalysisState`.

mod types;

// Future submodules:
// mod object_index;
// mod dominator_index;
// mod class_index;
// mod snapshot;

pub use types::HeapAnalysis;
