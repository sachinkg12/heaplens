//! Repeatable correctness/performance probe; stdout is one JSON record.
use anyhow::Result;
use hprof_analyzer::indexed::{
    analysis::IndexedAnalysisState, parse::parse_indexed, types::HeapAnalysis,
};
use hprof_analyzer::{build_graph, calculate_dominators_with_state, HprofLoader};
use std::hash::{Hash, Hasher};
use std::time::Instant;
fn main() -> Result<()> {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("HPROF path");
    let started = Instant::now();
    let data = HprofLoader::new(path.into()).map_file()?;
    let indexed = !args.iter().any(|s| s == "--legacy");
    let state: Box<dyn HeapAnalysis> = if indexed {
        Box::new(IndexedAnalysisState::from_parse_result(parse_indexed(
            &data,
        )?)?)
    } else {
        let (graph, waste) = build_graph(&data)?;
        Box::new(calculate_dominators_with_state(graph, waste)?.1)
    };
    let analysis_ms = started.elapsed().as_millis();
    let waste = state.get_waste_analysis();
    let mut rows = 0u64;
    let mut shallow_digest = 0u64;
    let mut retained_digest = 0u64;
    let mut inventory_digest = 0u64;
    // Audit mode includes a full query-table scan; report it separately from
    // analysis latency. The digest is order-independent across both backends.
    if !args.iter().any(|s| s == "--summary-only") {
        for row in state.scan_instances_table() {
            let id = row[0].as_u64().unwrap();
            let shallow = row[3].as_u64().unwrap();
            let retained = row[4].as_u64().unwrap();
            let digest = |pair: (u64, u64)| {
                let mut h = std::collections::hash_map::DefaultHasher::new();
                pair.hash(&mut h);
                h.finish()
            };
            inventory_digest ^= digest((id, 0));
            shallow_digest ^= digest((id, shallow));
            retained_digest ^= digest((id, retained));
            rows += 1;
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "backend":if indexed {"indexed"} else {"legacy"},
            "summary":state.get_summary(),"analysis_ms":analysis_ms,"audit_ms":started.elapsed().as_millis(),
            "rows":rows,"inventory_digest":inventory_digest,"shallow_digest":shallow_digest,"retained_digest":retained_digest,
            "histogram":state.get_class_histogram().iter().take(10).collect::<Vec<_>>(),
            "suspects":state.get_leak_suspects(),
            "waste_bytes":waste.total_wasted_bytes,
            "waste":waste
        })
    );
    Ok(())
}
