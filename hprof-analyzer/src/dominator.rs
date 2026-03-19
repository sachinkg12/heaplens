//! Dominator tree computation, retained size calculation, class histogram,
//! and leak suspect detection.

use anyhow::Result;
use petgraph::algo::dominators;
use petgraph::graph::NodeIndex;
use std::collections::HashMap;
use std::sync::Arc;

use crate::{
    NodeData, EdgeLabel, HeapGraph, HeapGraphParts, ObjectReport,
    ClassHistogramEntry, LeakSuspect, AnalysisState,
};
use crate::waste::{WasteRawData, WasteAnalysis};

/// Computes dominator tree and returns top 50 objects by retained size.
///
/// This is the simpler variant that does not build a full AnalysisState.
pub fn calculate_dominators(graph: &HeapGraph) -> Result<Vec<ObjectReport>> {
    log::debug!("Calculating dominators for {} nodes", graph.node_count());

    let petgraph = graph.graph();
    let super_root = graph.super_root();

    let doms = dominators::simple_fast(petgraph, super_root);
    log::info!("Dominator tree computed successfully");

    let node_count = petgraph.node_count();
    let mut children: HashMap<NodeIndex, Vec<NodeIndex>> = HashMap::with_capacity(node_count);

    for node_idx in petgraph.node_indices() {
        if node_idx == super_root {
            continue;
        }
        if let Some(dominator) = doms.immediate_dominator(node_idx) {
            children.entry(dominator).or_insert_with(Vec::new).push(node_idx);
        } else {
            children.entry(super_root).or_insert_with(Vec::new).push(node_idx);
        }
    }

    let mut shallow_sizes: Vec<u64> = vec![0u64; node_count];
    let mut retained_sizes: Vec<u64> = vec![0u64; node_count];

    for node_idx in petgraph.node_indices() {
        let i = node_idx.index();
        let shallow_size = match &petgraph[node_idx] {
            NodeData::SuperRoot | NodeData::Root | NodeData::Class => 0,
            NodeData::Instance { size, .. } => *size as u64,
            NodeData::Array { size, .. } => *size as u64,
        };
        shallow_sizes[i] = shallow_size;
        retained_sizes[i] = shallow_size;
    }

    let mut stack: Vec<(NodeIndex, bool)> = vec![(super_root, false)];
    let mut visited = std::collections::HashSet::new();

    while let Some((node, processed)) = stack.pop() {
        if processed {
            if let Some(node_children) = children.get(&node) {
                let ni = node.index();
                let mut retained = shallow_sizes[ni];
                for &child in node_children {
                    retained += retained_sizes[child.index()];
                }
                retained_sizes[ni] = retained;
            }
        } else {
            if !visited.insert(node) {
                continue;
            }
            stack.push((node, true));
            if let Some(node_children) = children.get(&node) {
                for &child in node_children {
                    if !visited.contains(&child) {
                        stack.push((child, false));
                    }
                }
            }
        }
    }

    // Use BinaryHeap to find top 50 without allocating for all nodes.
    // ObjectReport Ord is reversed (largest retained_size = smallest in Ord),
    // so BinaryHeap (max-heap) naturally keeps the largest retained sizes
    // and lets us pop the smallest.
    use std::collections::BinaryHeap;
    let mut heap: BinaryHeap<ObjectReport> = BinaryHeap::with_capacity(51);

    for node_idx in petgraph.node_indices() {
        let node_data = &petgraph[node_idx];
        let i = node_idx.index();
        let retained = retained_sizes[i];

        // Skip non-object nodes (0 retained size, never in top 50)
        let (object_id, node_type, class_name) = match node_data {
            NodeData::SuperRoot | NodeData::Root | NodeData::Class => continue,
            NodeData::Instance { id, class_name, .. } => (*id, "Instance".to_string(), class_name.clone()),
            NodeData::Array { id, class_name, .. } => (*id, "Array".to_string(), class_name.clone()),
        };

        let report = ObjectReport::new(object_id, node_type, class_name, shallow_sizes[i], retained, node_idx);
        heap.push(report);
        if heap.len() > 50 {
            heap.pop(); // Remove smallest retained_size
        }
    }

    let mut top_50: Vec<ObjectReport> = heap.into_sorted_vec();

    Ok(top_50)
}

/// Computes dominator tree, retained sizes, class histogram, leak suspects,
/// and waste analysis. Returns top 50 objects and the full AnalysisState.
pub fn calculate_dominators_with_state(graph: HeapGraph, waste_data: WasteRawData) -> Result<(Vec<ObjectReport>, AnalysisState)> {
    log::debug!("Calculating dominators with state for {} nodes", graph.node_count());

    let HeapGraphParts { graph: petgraph, id_to_node, super_root, mut summary, classloader_ids, field_name_table, class_field_layouts, id_size } = graph.into_parts();

    // Step 1: Compute dominator tree
    let doms = dominators::simple_fast(&petgraph, super_root);
    log::info!("Dominator tree computed successfully");

    // Step 1b: Build reverse reference adjacency list
    let mut reverse_refs: HashMap<NodeIndex, Vec<(NodeIndex, EdgeLabel)>> = HashMap::with_capacity(petgraph.node_count());
    for edge in petgraph.edge_indices() {
        if let Some((source, target)) = petgraph.edge_endpoints(edge) {
            let label = petgraph[edge];
            reverse_refs.entry(target).or_insert_with(Vec::new).push((source, label));
        }
    }
    log::info!("Built reverse reference map: {} entries", reverse_refs.len());

    // Step 2: Build children map
    let mut children_map: HashMap<NodeIndex, Vec<NodeIndex>> = HashMap::with_capacity(petgraph.node_count());
    let mut unreachable_count = 0u64;
    let mut unreachable_shallow_size = 0u64;
    for node_idx in petgraph.node_indices() {
        if node_idx == super_root {
            continue;
        }
        if let Some(dominator) = doms.immediate_dominator(node_idx) {
            children_map.entry(dominator).or_insert_with(Vec::new).push(node_idx);
        } else {
            children_map.entry(super_root).or_insert_with(Vec::new).push(node_idx);
            unreachable_count += 1;
            let node_size = match &petgraph[node_idx] {
                NodeData::Instance { size, .. } | NodeData::Array { size, .. } => *size as u64,
                _ => 0,
            };
            unreachable_shallow_size += node_size;
        }
    }
    log::info!("Dominator tree: {} unreachable nodes ({:.2} MB) attached to SuperRoot",
        unreachable_count, unreachable_shallow_size as f64 / (1024.0 * 1024.0));

    // Steps 3+4: Calculate shallow and retained sizes
    let node_count = petgraph.node_count();
    let mut shallow_sizes: Vec<u64> = vec![0u64; node_count];
    let mut retained_sizes: Vec<u64> = vec![0u64; node_count];
    for node_idx in petgraph.node_indices() {
        let i = node_idx.index();
        let shallow_size = match &petgraph[node_idx] {
            NodeData::SuperRoot | NodeData::Root | NodeData::Class => 0,
            NodeData::Instance { size, .. } => *size as u64,
            NodeData::Array { size, .. } => *size as u64,
        };
        shallow_sizes[i] = shallow_size;
        retained_sizes[i] = shallow_size;
    }

    // DFS post-order traversal
    let mut stack: Vec<(NodeIndex, bool)> = vec![(super_root, false)];
    let mut visited = std::collections::HashSet::new();

    while let Some((node, processed)) = stack.pop() {
        if processed {
            if let Some(node_children) = children_map.get(&node) {
                let ni = node.index();
                let mut retained = shallow_sizes[ni];
                for &child in node_children {
                    retained += retained_sizes[child.index()];
                }
                retained_sizes[ni] = retained;
            }
        } else {
            if !visited.insert(node) {
                continue;
            }
            stack.push((node, true));
            if let Some(node_children) = children_map.get(&node) {
                for &child in node_children {
                    if !visited.contains(&child) {
                        stack.push((child, false));
                    }
                }
            }
        }
    }
    log::info!("Calculated retained sizes for {} nodes", node_count);

    // Steps 5+6: Build node_data_map, ObjectReports, and class histogram
    let mut class_name_intern: HashMap<String, Arc<str>> = HashMap::new();
    let empty_class: Arc<str> = Arc::from("");
    let mut node_data_map: Vec<(u64, &'static str, Arc<str>)> = Vec::with_capacity(node_count);
    for _ in 0..node_count {
        node_data_map.push((0, "Unknown", empty_class.clone()));
    }
    // Use BinaryHeap to track top 50 without allocating for all nodes.
    use std::collections::BinaryHeap;
    let mut top_heap: BinaryHeap<ObjectReport> = BinaryHeap::with_capacity(51);
    let mut histogram_map: HashMap<String, (u64, u64, u64)> = HashMap::new();

    for node_idx in petgraph.node_indices() {
        let i = node_idx.index();
        let node_data = &petgraph[node_idx];
        let shallow = shallow_sizes[i];
        let retained = retained_sizes[i];

        let (object_id, node_type, class_name_arc): (u64, &'static str, Arc<str>) = match node_data {
            NodeData::SuperRoot => (0, "SuperRoot", empty_class.clone()),
            NodeData::Root => (0, "Root", empty_class.clone()),
            NodeData::Class => (0, "Class", empty_class.clone()),
            NodeData::Instance { id, class_name, .. } => {
                let interned = if let Some(existing) = class_name_intern.get(class_name) {
                    existing.clone()
                } else {
                    let arc: Arc<str> = Arc::from(class_name.as_str());
                    class_name_intern.insert(class_name.clone(), arc.clone());
                    arc
                };
                let entry = histogram_map.entry(class_name.clone()).or_insert((0, 0, 0));
                entry.0 += 1;
                entry.1 += shallow;
                entry.2 += retained;
                (*id, "Instance", interned)
            }
            NodeData::Array { id, class_name, .. } => {
                let interned = if let Some(existing) = class_name_intern.get(class_name) {
                    existing.clone()
                } else {
                    let arc: Arc<str> = Arc::from(class_name.as_str());
                    class_name_intern.insert(class_name.clone(), arc.clone());
                    arc
                };
                let entry = histogram_map.entry(class_name.clone()).or_insert((0, 0, 0));
                entry.0 += 1;
                entry.1 += shallow;
                entry.2 += retained;
                (*id, "Array", interned)
            }
        };

        node_data_map[node_idx.index()] = (object_id, node_type, class_name_arc.clone());

        // Only track Instance/Array in top-50 heap (SuperRoot/Root/Class have 0 retained)
        if retained > 0 {
            let report = ObjectReport::new(
                object_id, node_type.to_string(), class_name_arc.to_string(),
                shallow, retained, node_idx,
            );
            top_heap.push(report);
            if top_heap.len() > 50 {
                top_heap.pop();
            }
        }
    }

    let mut top_50: Vec<ObjectReport> = top_heap.into_sorted_vec();

    let mut class_histogram: Vec<ClassHistogramEntry> = histogram_map
        .into_iter()
        .map(|(class_name, (instance_count, shallow_size, retained_size))| {
            ClassHistogramEntry { class_name, instance_count, shallow_size, retained_size }
        })
        .collect();
    class_histogram.sort_by(|a, b| b.retained_size.cmp(&a.retained_size));
    log::info!("Computed class histogram: {} classes", class_histogram.len());

    // Step 7: Detect leak suspects
    let total_heap_size = summary.total_heap_size;
    let reachable_heap_size = if unreachable_shallow_size < total_heap_size {
        total_heap_size - unreachable_shallow_size
    } else {
        total_heap_size
    };
    log::info!("Heap sizes: total={:.2} MB, unreachable={:.2} MB, reachable={:.2} MB",
        total_heap_size as f64 / (1024.0 * 1024.0),
        unreachable_shallow_size as f64 / (1024.0 * 1024.0),
        reachable_heap_size as f64 / (1024.0 * 1024.0));
    summary.reachable_heap_size = reachable_heap_size;
    let mut leak_suspects = Vec::new();

    if reachable_heap_size > 0 {
        let threshold_pct = 5.0;
        let threshold_bytes = (reachable_heap_size as f64 * threshold_pct / 100.0) as u64;

        // Phase 1: Classloader suspects
        let mut classloader_suspects: Vec<(NodeIndex, u64, f64, u64, String)> = Vec::new();
        for &cl_id in &classloader_ids {
            if let Some(&node_idx) = id_to_node.get(&cl_id) {
                let ni = node_idx.index();
                let retained = retained_sizes[ni];
                if retained < threshold_bytes {
                    continue;
                }
                let percentage = (retained as f64 / reachable_heap_size as f64) * 100.0;
                let (object_id, class_name) = {
                    let (id, _, ref cn) = node_data_map[ni];
                    (id, cn.to_string())
                };
                if class_name.is_empty() {
                    continue;
                }
                classloader_suspects.push((node_idx, retained, percentage, object_id, class_name));
            }
        }
        classloader_suspects.sort_by(|a, b| b.1.cmp(&a.1));

        for (node_idx, retained, percentage, object_id, class_name) in classloader_suspects.iter().take(5) {
            let mut accum_node = *node_idx;
            let mut accum_retained = *retained;
            loop {
                if let Some(dom_children) = children_map.get(&accum_node) {
                    let mut max_child = None;
                    let mut max_child_ret = 0u64;
                    for &child in dom_children {
                        let child_ret = retained_sizes[child.index()];
                        if child_ret > max_child_ret {
                            max_child_ret = child_ret;
                            max_child = Some(child);
                        }
                    }
                    if let Some(child) = max_child {
                        if max_child_ret > accum_retained * 4 / 5 {
                            accum_node = child;
                            accum_retained = max_child_ret;
                            continue;
                        }
                    }
                }
                break;
            }

            let accum_info = if accum_node != *node_idx {
                let (_, _, ref accum_cn) = node_data_map[accum_node.index()];
                format!(". Memory accumulated in {} ({:.2} MB)",
                    accum_cn, accum_retained as f64 / (1024.0 * 1024.0))
            } else {
                String::new()
            };

            leak_suspects.push(LeakSuspect {
                class_name: class_name.clone(),
                object_id: *object_id,
                retained_size: *retained,
                retained_percentage: *percentage,
                description: format!(
                    "Classloader {} retains {:.1}% of reachable heap ({:.2} MB){}",
                    class_name, percentage, *retained as f64 / (1024.0 * 1024.0), accum_info,
                ),
            });
        }

        // Phase 2: Non-classloader individual suspects
        let classloader_suspect_nodes: std::collections::HashSet<NodeIndex> = leak_suspects
            .iter().filter_map(|s| id_to_node.get(&s.object_id).copied()).collect();

        let mut other_candidates: Vec<(NodeIndex, u64, f64)> = Vec::new();
        for node_idx in petgraph.node_indices() {
            if classloader_suspect_nodes.contains(&node_idx) {
                continue;
            }
            let ni = node_idx.index();
            let (_, node_type, _) = node_data_map[ni];
            if node_type != "Instance" && node_type != "Array" {
                continue;
            }
            let retained = retained_sizes[ni];
            if retained < threshold_bytes {
                continue;
            }
            let mut is_under_cl_suspect = false;
            if let Some(dominator) = doms.immediate_dominator(node_idx) {
                let mut check = dominator;
                for _ in 0..20 {
                    if classloader_suspect_nodes.contains(&check) {
                        is_under_cl_suspect = true;
                        break;
                    }
                    match doms.immediate_dominator(check) {
                        Some(parent) if parent != check => check = parent,
                        _ => break,
                    }
                }
            }
            if is_under_cl_suspect {
                continue;
            }
            let percentage = (retained as f64 / reachable_heap_size as f64) * 100.0;
            other_candidates.push((node_idx, retained, percentage));
        }
        other_candidates.sort_by(|a, b| b.1.cmp(&a.1));

        let other_set: std::collections::HashSet<NodeIndex> = other_candidates
            .iter().map(|&(idx, _, _)| idx).collect();
        let mut skip_set: std::collections::HashSet<NodeIndex> = std::collections::HashSet::new();
        for &(node_idx, retained, _) in &other_candidates {
            if let Some(dom_children) = children_map.get(&node_idx) {
                for &child in dom_children {
                    if other_set.contains(&child) {
                        let child_retained = retained_sizes[child.index()];
                        if child_retained > retained * 9 / 10 {
                            skip_set.insert(node_idx);
                            break;
                        }
                    }
                }
            }
        }

        for &(node_idx, retained, percentage) in other_candidates.iter().take(10) {
            if skip_set.contains(&node_idx) {
                continue;
            }
            if leak_suspects.len() >= 10 {
                break;
            }
            let (object_id, _, ref cn) = node_data_map[node_idx.index()];
            let class_name = cn.to_string();
            let display_name = if class_name.is_empty() { "Unknown".to_string() } else { class_name };
            leak_suspects.push(LeakSuspect {
                class_name: display_name.clone(),
                object_id,
                retained_size: retained,
                retained_percentage: percentage,
                description: format!(
                    "Single {} instance retains {:.1}% of reachable heap ({:.2} MB)",
                    display_name, percentage, retained as f64 / (1024.0 * 1024.0)
                ),
            });
        }

        // Phase 3: Class-level suspects
        for entry in &class_histogram {
            let percentage = (entry.retained_size as f64 / reachable_heap_size as f64) * 100.0;
            if percentage > 10.0 && entry.instance_count > 1 {
                let already_covered = leak_suspects.iter()
                    .any(|s| s.class_name == entry.class_name);
                if !already_covered {
                    leak_suspects.push(LeakSuspect {
                        class_name: entry.class_name.clone(),
                        object_id: 0,
                        retained_size: entry.retained_size,
                        retained_percentage: percentage,
                        description: format!(
                            "{} instances of {} collectively retain {:.1}% of reachable heap ({:.2} MB)",
                            entry.instance_count, entry.class_name, percentage,
                            entry.retained_size as f64 / (1024.0 * 1024.0)
                        ),
                    });
                }
            }
        }

        leak_suspects.sort_by(|a, b| b.retained_percentage.partial_cmp(&a.retained_percentage).unwrap_or(std::cmp::Ordering::Equal));
    }
    log::info!("Detected {} leak suspects", leak_suspects.len());

    // Step 8: Compute waste analysis
    let waste_analysis = crate::waste::compute_waste_analysis(&waste_data, summary.total_heap_size);

    let state = AnalysisState {
        children_map,
        retained_sizes,
        shallow_sizes,
        id_to_node,
        super_root,
        node_data_map,
        class_histogram,
        leak_suspects,
        summary,
        reverse_refs,
        waste_analysis,
        field_name_table,
        class_field_layouts,
        id_size,
    };

    Ok((top_50, state))
}
