//! Bounded projections over existing immutable columns. Never decodes raw heap values.
use super::{IndexedAnalysisState, NodeType};
use crate::investigation::{name, Budget, Operation, Request, MAX_DEPTH, MAX_ROWS};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

fn object(state: &IndexedAnalysisState, index: u32) -> Value {
    let n = state.node_store.get_by_index(index);
    json!({"object_id":n.id.to_string(),"class_name":name(&n.class_name),
        "node_type":format!("{:?}",n.node_type),"shallow_size":n.shallow_size.to_string(),
        "retained_size":state.dominator.retained_sizes[index as usize].to_string(),
        "name_truncated":n.class_name.chars().nth(256).is_some()})
}

pub(super) fn read(
    state: &IndexedAnalysisState,
    request: &Request,
    budget: &mut Budget,
) -> Result<Value> {
    budget.check()?;
    let id = request.object_id()?;
    let index = state
        .node_store
        .index_of(id)
        .ok_or_else(|| anyhow::anyhow!("Object is not in this analysis"))?;
    let selected = object(state, index);
    let mut result = json!({"schema_version":1,"operation":request.operation,"selected":selected,
        "rows":[],"truncated":false,"status":"complete",
        "size_note":"Engine sizing model applies; not a producer measurement or allocation history",
        "reference_note":"Edges follow this analysis reference policy; dominator children are not outgoing references"});
    match request.operation {
        Operation::Object => {}
        Operation::Fields => {
            if let Some((class, _, _)) =
                state.object_bodies.as_ref().and_then(|b| b.location(index))
            {
                if let Some(layout) = state.class_index.field_layout(class) {
                    let mut rows = Vec::new();
                    for (field, kind) in layout.iter().take(MAX_ROWS) {
                        budget.node()?;
                        rows.push(json!({"name":name(field),"field_type":format!("{:?}",kind),"name_truncated":field.chars().nth(256).is_some()}));
                    }
                    result["rows"] = json!(rows);
                    result["total"] = json!(layout.len().to_string());
                    result["truncated"] = json!(layout.len() > MAX_ROWS);
                } else {
                    result["status"] = json!("unavailable");
                }
            } else {
                result["status"] = json!("unavailable");
            }
        }
        Operation::Outbound | Operation::Referrers | Operation::Children => {
            let neighbors = match request.operation {
                Operation::Outbound => state.edge_store.neighbors(index),
                Operation::Referrers => state.edge_store.reverse_neighbors(index),
                _ => &state.dominator.dominator_children[index as usize],
            };
            let mut rows = Vec::new();
            for &next in neighbors.iter().take(MAX_ROWS) {
                budget.edge()?;
                budget.node()?;
                rows.push(object(state, next));
            }
            result["rows"] = json!(rows);
            result["total"] = json!(neighbors.len().to_string());
            result["truncated"] = json!(neighbors.len() > MAX_ROWS);
            result["order"] =
                json!("engine order; bounded prefix, not a ranked or complete sample");
        }
        Operation::RootPath => {
            let (rows, status, truncated) = root_path(state, index, budget)?;
            result["rows"] = json!(rows);
            result["status"] = json!(status);
            result["truncated"] = json!(truncated);
            result["path_note"]=json!("Root-to-selected order; no returned path does not establish unreachable or leak-free status");
        }
    }
    budget.check()?;
    result["work"] = json!({"nodes":budget.nodes,"edges":budget.edges});
    ensure!(
        serde_json::to_vec(&result)?.len() <= crate::investigation::MAX_BYTES,
        "Investigation output budget exceeded"
    );
    Ok(result)
}

fn root_path(
    state: &IndexedAnalysisState,
    target: u32,
    budget: &mut Budget,
) -> Result<(Vec<Value>, &'static str, bool)> {
    let mut parents: HashMap<u32, Option<u32>> = HashMap::new();
    let mut queue = VecDeque::new();
    budget.node()?;
    parents.insert(target, None);
    queue.push_back((target, 0));
    let mut clipped = false;
    while let Some((current, depth)) = queue.pop_front() {
        budget.check()?;
        if matches!(
            state.node_store.kind_at(current),
            NodeType::GcRoot | NodeType::SuperRoot
        ) {
            let mut rows = Vec::new();
            let mut at = Some(current);
            while let Some(index) = at {
                budget.check()?;
                rows.push(object(state, index));
                at = parents[&index];
            }
            return Ok((rows, "found", false));
        }
        if depth >= MAX_DEPTH {
            clipped = true;
            continue;
        }
        for &next in state.edge_store.reverse_neighbors(current) {
            if budget.edge().is_err() {
                budget.check()?;
                return Ok((Vec::new(), "budget_exhausted", true));
            }
            if let std::collections::hash_map::Entry::Vacant(entry) = parents.entry(next) {
                if budget.node().is_err() {
                    budget.check()?;
                    return Ok((Vec::new(), "budget_exhausted", true));
                }
                entry.insert(Some(current));
                queue.push_back((next, depth + 1));
            }
        }
    }
    Ok((
        Vec::new(),
        if clipped {
            "budget_exhausted"
        } else {
            "no_path_found"
        },
        clipped,
    ))
}
