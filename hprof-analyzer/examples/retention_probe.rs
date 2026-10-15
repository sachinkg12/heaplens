//! Research diagnostic: retain original addresses and expose the graph's exact
//! weights. Reweighting another graph is reconciliation, not a sizing oracle.
use anyhow::{ensure, Context, Result};
use hprof_analyzer::indexed::{
    dominator::compute_dominators,
    node_store::NodeType,
    storage::{load_structure, StorageMode, StorageOptions},
};
use std::{
    collections::{BTreeMap, HashMap},
    io::Write,
    sync::{atomic::AtomicBool, Arc},
};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 6 || (args.len() == 7 && args[6] == "--members"),
        "dump mode cache-directory selected-addresses weights-output [--members]"
    );
    let mapping = Arc::new(hprof_analyzer::HprofLoader::new(args[1].clone().into()).map_file()?);
    let options = StorageOptions {
        mode: StorageMode::parse(&args[2])?,
        cache_dir: Some(args[3].clone().into()),
        edge_buffer_bytes: 64 * 1024 * 1024,
    };
    let (one, two, storage) = load_structure(mapping, &options, &AtomicBool::new(false))?;
    let mut sizes: HashMap<&str, u64> = HashMap::new();
    for node in one
        .node_store
        .iter()
        .filter(|node| node.node_type == NodeType::Instance)
    {
        if let Some(previous) = sizes.insert(&node.class_name, node.shallow_size) {
            ensure!(
                previous == node.shallow_size,
                "Different layouts share class name {}",
                node.class_name
            );
        }
    }
    let mut weights = BTreeMap::new();
    for node in one
        .node_store
        .iter()
        .filter(|node| node.node_type == NodeType::Class)
    {
        if let Some(class) = one.class_index.get(node.id) {
            if let Some(&size) = sizes.get(class.class_name.as_ref()) {
                weights.insert(node.id, size);
            }
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&args[5])?;
    for (class, size) in &weights {
        writeln!(file, "{class}\t{size}")?;
    }
    drop(sizes);
    let mut root_file = std::fs::OpenOptions::new().create_new(true).write(true)
        .open(format!("{}.roots", &args[5]))?;
    for root in &one.gc_root_ids { writeln!(root_file, "{root}")?; }
    let roots: Vec<_> = one
        .gc_root_ids
        .iter()
        .filter_map(|&id| one.node_store.index_of(id))
        .collect();
    let dominators = compute_dominators(&one.node_store, &two.edge_store, &roots);
    let mut samples = Vec::new();
    for text in args[4].split(',') {
        let address = text.parse::<u64>()?;
        let index = one
            .node_store
            .index_of(address)
            .context("Selected address missing")?;
        let node = one.node_store.get_by_index(index);
        if args.len() == 7 {
            let file = std::fs::OpenOptions::new().create_new(true).write(true)
                .open(format!("{}.retained-{address}.bin", args[5]))?;
            let mut file = std::io::BufWriter::new(file);
            let mut stack = vec![index];
            while let Some(current) = stack.pop() {
                let node = one.node_store.get_by_index(current);
                file.write_all(&node.id.to_le_bytes())?;
                file.write_all(&node.shallow_size.to_le_bytes())?;
                stack.extend(dominators.dominator_children[current as usize].iter().copied());
            }
            file.flush()?;
        }
        let parent = dominators.dominator_parent[index as usize];
        let incoming = two.edge_store.reverse_neighbors(index);
        let outgoing = two.edge_store.neighbors(index);
        let limited = |nodes: &[u32]| {
            nodes.iter().take(32).map(|&i| {
            let node = one.node_store.get_by_index(i);
            serde_json::json!({"address": node.id.to_string(), "class_name": node.class_name})
        }).collect::<Vec<_>>()
        };
        samples.push(serde_json::json!({"address": text, "class_name": node.class_name,
            "shallow_bytes": node.shallow_size, "retained_bytes": dominators.retained_sizes[index as usize],
            "dominator_address": (parent != u32::MAX).then(|| one.node_store.get_by_index(parent).id.to_string()),
            "incoming_count": incoming.len(), "outgoing_count": outgoing.len(),
            "incoming_first_32": limited(incoming), "outgoing_first_32": limited(outgoing)}));
    }
    let nodes = one.node_store.len();
    let edges = two.edge_store.edge_count();
    let mut summary = one.summary;
    summary.reachable_heap_size = summary.total_heap_size - dominators.unreachable_shallow_size;
    println!(
        "{}",
        serde_json::json!({"status": "completed", "summary": summary,
        "storage": storage, "nodes": nodes, "edges": edges, "object_samples": samples,
        "histogram": one.class_histogram, "instance_weight_classes": weights.len()})
    );
    Ok(())
}
