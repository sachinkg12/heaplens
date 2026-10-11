//! Loading is a CLI adapter over the existing engine, not another analyzer.
use super::{args::Backend, Failure};
use hprof_analyzer::{
    indexed::{HeapAnalysis, IndexedAnalysisState},
    HprofLoader,
};
use jvm_hprof::{parse_hprof, RecordTag};
use std::path::Path;

pub fn load(path: &Path, backend: Backend, quiet: bool) -> Result<Box<dyn HeapAnalysis>, Failure> {
    let metadata = std::fs::metadata(path).map_err(|_| Failure::input())?;
    if !metadata.is_file() {
        return Err(Failure::input());
    }
    progress(quiet, "Mapping and validating heap");
    let mmap = HprofLoader::new(path.into())
        .map_file()
        .map_err(|_| Failure::input())?;
    // Reject header-only/unfinished captures. Record and payload parsing still
    // belongs to the vendored parser and existing analysis implementations.
    validate(&mmap)?;
    progress(quiet, "Parsing references and computing retained sizes");
    match backend {
        Backend::Indexed => {
            let parsed = hprof_analyzer::indexed::parse::parse_indexed(&mmap)
                .map_err(|_| Failure::analysis())?;
            let state =
                IndexedAnalysisState::from_parse_result(parsed).map_err(|_| Failure::analysis())?;
            Ok(Box::new(state))
        }
        Backend::Legacy => {
            let (graph, waste) =
                hprof_analyzer::build_graph(&mmap).map_err(|_| Failure::analysis())?;
            let (_, state) = hprof_analyzer::calculate_dominators_with_state(graph, waste)
                .map_err(|_| Failure::analysis())?;
            Ok(Box::new(state))
        }
    }
}

fn validate(bytes: &[u8]) -> Result<(), Failure> {
    let heap = parse_hprof(bytes).map_err(|_| Failure::analysis())?;
    if !matches!(
        heap.header().label(),
        Ok("JAVA PROFILE 1.0.1" | "JAVA PROFILE 1.0.2" | "JAVA PROFILE 1.0.3")
    ) {
        return Err(Failure::analysis());
    }
    let mut has_heap = false;
    let mut segment_open = false;
    for record in heap.records_iter() {
        match record.map_err(|_| Failure::analysis())?.tag() {
            RecordTag::HeapDump => {
                has_heap = true;
            }
            RecordTag::HeapDumpSegment => {
                has_heap = true;
                segment_open = true;
            }
            RecordTag::HeapDumpEnd => {
                segment_open = false;
            }
            _ => {}
        }
    }
    if !has_heap || segment_open {
        return Err(Failure::analysis());
    }
    Ok(())
}

pub fn progress(quiet: bool, message: &str) {
    if !quiet {
        eprintln!("[HeapLens] {message}");
    }
}
