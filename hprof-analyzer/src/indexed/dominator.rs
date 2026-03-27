//! Dominator tree computation on CSR (Compressed Sparse Row) edge stores.
//!
//! Implements the Lengauer-Tarjan algorithm for computing the dominator tree
//! directly on the `EdgeStore` CSR format, avoiding the need for petgraph.
//! After computing dominators, retained sizes are calculated bottom-up.

use super::edge_store::EdgeStore;
use super::node_store::NodeStore;

/// Result of dominator tree computation.
pub struct DominatorResult {
    /// Retained size per node index.
    pub retained_sizes: Vec<u64>,
    /// Parent in dominator tree per node index. `u32::MAX` means no parent.
    pub dominator_parent: Vec<u32>,
    /// Children in dominator tree per node index.
    pub dominator_children: Vec<Vec<u32>>,
}

/// Computes the dominator tree and retained sizes for a heap graph.
///
/// Uses a simplified Lengauer-Tarjan algorithm:
/// 1. DFS from a virtual super-root (index 0) that connects to all GC roots
/// 2. Compute semidominators using ancestor path compression
/// 3. Derive immediate dominators
/// 4. Compute retained sizes bottom-up from the dominator tree
///
/// The `gc_root_indices` should be the node indices (not HPROF IDs) of GC root
/// nodes. The super-root at index 0 is assumed to already exist in the NodeStore
/// and already have edges to the GC roots in the EdgeStore.
pub fn compute_dominators(
    node_store: &NodeStore,
    edge_store: &EdgeStore,
    _gc_root_indices: &[u32],
) -> DominatorResult {
    let n = node_store.len();

    if n == 0 {
        return DominatorResult {
            retained_sizes: Vec::new(),
            dominator_parent: Vec::new(),
            dominator_children: Vec::new(),
        };
    }

    // The super-root is node 0. It already has edges to GC roots in the EdgeStore.
    let root: u32 = 0;

    // --- Lengauer-Tarjan dominator algorithm ---

    // DFS numbering
    let mut semi: Vec<u32> = vec![0; n];       // semi[v] = DFS number of semidominator of v
    let mut vertex: Vec<u32> = vec![0; n];     // vertex[i] = node with DFS number i
    let mut parent: Vec<u32> = vec![u32::MAX; n]; // DFS tree parent
    let mut dfnum: Vec<u32> = vec![u32::MAX; n];  // DFS number of each node
    let mut dfs_count: u32 = 0;

    // Iterative DFS to avoid stack overflow on deep graphs
    {
        let mut stack: Vec<(u32, bool)> = Vec::with_capacity(n.min(1024));
        stack.push((root, false));

        while let Some((v, visited)) = stack.pop() {
            if visited {
                continue;
            }
            if dfnum[v as usize] != u32::MAX {
                continue;
            }
            dfnum[v as usize] = dfs_count;
            semi[v as usize] = dfs_count;
            vertex[dfs_count as usize] = v;
            dfs_count += 1;

            // Push successors in reverse order so they're visited in forward order
            let neighbors = edge_store.neighbors(v);
            for &w in neighbors.iter().rev() {
                if (w as usize) < n && dfnum[w as usize] == u32::MAX {
                    parent[w as usize] = v;
                    stack.push((w, false));
                }
            }
        }
    }

    let reachable = dfs_count as usize;

    if reachable <= 1 {
        // Only the root or nothing is reachable
        let mut retained_sizes: Vec<u64> = Vec::with_capacity(n);
        for i in 0..n {
            retained_sizes.push(node_store.get_by_index(i as u32).shallow_size as u64);
        }
        let dominator_parent = vec![u32::MAX; n];
        let dominator_children = vec![Vec::new(); n];
        return DominatorResult {
            retained_sizes,
            dominator_parent,
            dominator_children,
        };
    }

    // Union-Find with path compression for ancestor queries
    let mut ancestor: Vec<u32> = vec![u32::MAX; n]; // ancestor in the forest
    let mut label: Vec<u32> = (0..n as u32).collect();   // label[v] = node with min semi on path

    // Implicit link: ancestor[w] = v means v is w's ancestor in the forest
    fn compress(v: u32, ancestor: &mut [u32], _semi: &[u32], dfnum: &[u32], label: &mut [u32]) {
        let mut stack = Vec::new();
        let mut cur = v;
        // Walk up to find the root of the tree
        while ancestor[ancestor[cur as usize] as usize] != u32::MAX {
            stack.push(cur);
            cur = ancestor[cur as usize];
        }
        // Now compress path
        for &node in stack.iter().rev() {
            let a = ancestor[node as usize];
            if dfnum[label[a as usize] as usize] < dfnum[label[node as usize] as usize] {
                label[node as usize] = label[a as usize];
            }
            ancestor[node as usize] = ancestor[a as usize];
        }
    }

    fn eval(v: u32, ancestor: &mut [u32], semi: &[u32], dfnum: &[u32], label: &mut [u32]) -> u32 {
        if ancestor[v as usize] == u32::MAX {
            return v;
        }
        compress(v, ancestor, semi, dfnum, label);
        label[v as usize]
    }

    // Buckets: bucket[v] = set of nodes whose semidominator is v
    let mut bucket: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut idom: Vec<u32> = vec![u32::MAX; n];

    // Process nodes in reverse DFS order (skip root at DFS number 0)
    for i in (1..reachable).rev() {
        let w = vertex[i];

        // Step 2: Compute semidominator
        for &v in edge_store.reverse_neighbors(w) {
            if (v as usize) < n && dfnum[v as usize] != u32::MAX {
                let u = eval(v, &mut ancestor, &semi, &dfnum, &mut label);
                if semi[u as usize] < semi[w as usize] {
                    semi[w as usize] = semi[u as usize];
                }
            }
        }

        // Add w to the bucket of its semidominator
        let semi_node = vertex[semi[w as usize] as usize];
        bucket[semi_node as usize].push(w);

        // Link w to its DFS tree parent
        let p = parent[w as usize];
        ancestor[w as usize] = p;

        // Step 3: Process bucket of parent
        let bucket_entries: Vec<u32> = std::mem::take(&mut bucket[p as usize]);
        for v in bucket_entries {
            let u = eval(v, &mut ancestor, &semi, &dfnum, &mut label);
            if semi[u as usize] < semi[v as usize] {
                idom[v as usize] = u;
            } else {
                idom[v as usize] = p;
            }
        }
    }

    // Step 4: Adjust immediate dominators
    for i in 1..reachable {
        let w = vertex[i];
        let semi_node = vertex[semi[w as usize] as usize];
        if idom[w as usize] != semi_node {
            idom[w as usize] = idom[idom[w as usize] as usize];
        }
    }

    // Root has no dominator
    idom[root as usize] = u32::MAX;

    // --- Build dominator tree structure ---

    let mut dominator_parent: Vec<u32> = vec![u32::MAX; n];
    let mut dominator_children: Vec<Vec<u32>> = vec![Vec::new(); n];

    for i in 0..n {
        let node = i as u32;
        if node == root {
            continue;
        }
        if dfnum[i] == u32::MAX {
            // Unreachable node: attach to root
            dominator_parent[i] = root;
            dominator_children[root as usize].push(node);
        } else if idom[i] != u32::MAX {
            dominator_parent[i] = idom[i];
            dominator_children[idom[i] as usize].push(node);
        }
    }

    // --- Compute retained sizes bottom-up ---

    let mut retained_sizes: Vec<u64> = Vec::with_capacity(n);
    for i in 0..n {
        retained_sizes.push(node_store.get_by_index(i as u32).shallow_size as u64);
    }

    // Process in reverse DFS order: children before parents.
    // First handle reachable nodes in reverse DFS order.
    for i in (1..reachable).rev() {
        let w = vertex[i] as usize;
        if dominator_parent[w] != u32::MAX {
            let p = dominator_parent[w] as usize;
            retained_sizes[p] += retained_sizes[w];
        }
    }

    // Then handle unreachable nodes (they are children of root but not in DFS order).
    // Their retained size is just their shallow size (no children in dominator tree
    // unless they dominate other unreachable nodes, which can't happen since they
    // are all individually attached to root).
    // Actually, unreachable nodes' retained sizes are already accounted for since
    // they are dominator children of root and will be added to root's retained size.
    // But we need to add them to root's retained size.
    for i in 0..n {
        if dfnum[i] == u32::MAX && (i as u32) != root {
            let p = dominator_parent[i] as usize;
            retained_sizes[p] += retained_sizes[i];
        }
    }

    DominatorResult {
        retained_sizes,
        dominator_parent,
        dominator_children,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed::edge_store::EdgeBuilder;
    use crate::indexed::node_store::{NodeStore, NodeType};
    use std::sync::Arc;

    /// Helper to build a test graph and compute dominators.
    fn make_test(
        node_count: usize,
        edges: &[(u32, u32)],
        gc_roots: &[u32],
        shallow_sizes: &[u32],
    ) -> DominatorResult {
        let mut ns = NodeStore::new();
        // Node 0 is super-root
        ns.add_node(0, 0, shallow_sizes.first().copied().unwrap_or(0), NodeType::SuperRoot, Arc::from("SuperRoot"));
        for i in 1..node_count {
            let size = shallow_sizes.get(i).copied().unwrap_or(0);
            ns.add_node(
                i as u64,
                0,
                size,
                NodeType::Instance,
                Arc::from(format!("Node{}", i).as_str()),
            );
        }

        let mut eb = EdgeBuilder::with_capacity(edges.len() + gc_roots.len());
        // SuperRoot -> GC roots
        for &r in gc_roots {
            eb.add_edge(0, r, 0);
        }
        for &(src, dst) in edges {
            eb.add_edge(src, dst, 1);
        }
        let es = eb.build(node_count);

        compute_dominators(&ns, &es, gc_roots)
    }

    #[test]
    fn empty_graph() {
        let ns = NodeStore::new();
        let es = EdgeBuilder::new().build(0);
        let result = compute_dominators(&ns, &es, &[]);
        assert!(result.retained_sizes.is_empty());
        assert!(result.dominator_parent.is_empty());
    }

    #[test]
    fn single_root() {
        // SuperRoot(0) -> Node(1)
        let result = make_test(2, &[], &[1], &[0, 100]);
        assert_eq!(result.retained_sizes[1], 100);
        // Root retains itself + node 1
        assert_eq!(result.retained_sizes[0], 100);
        assert_eq!(result.dominator_parent[1], 0);
    }

    #[test]
    fn linear_chain() {
        // SuperRoot(0) -> 1 -> 2 -> 3
        let result = make_test(
            4,
            &[(1, 2), (2, 3)],
            &[1],
            &[0, 10, 20, 30],
        );
        // 3 is dominated by 2, 2 by 1, 1 by root
        assert_eq!(result.dominator_parent[3], 2);
        assert_eq!(result.dominator_parent[2], 1);
        assert_eq!(result.dominator_parent[1], 0);

        // Retained: 3=30, 2=20+30=50, 1=10+50=60, 0=0+60=60
        assert_eq!(result.retained_sizes[3], 30);
        assert_eq!(result.retained_sizes[2], 50);
        assert_eq!(result.retained_sizes[1], 60);
        assert_eq!(result.retained_sizes[0], 60);
    }

    #[test]
    fn diamond_graph() {
        // SuperRoot(0) -> 1
        // 1 -> 2, 1 -> 3
        // 2 -> 4, 3 -> 4
        let result = make_test(
            5,
            &[(1, 2), (1, 3), (2, 4), (3, 4)],
            &[1],
            &[0, 10, 20, 30, 40],
        );
        // 4 is reached from both 2 and 3, but both are dominated by 1,
        // so 4's immediate dominator should be 1
        assert_eq!(result.dominator_parent[4], 1);
        assert_eq!(result.dominator_parent[2], 1);
        assert_eq!(result.dominator_parent[3], 1);

        // Retained: 4=40, 2=20, 3=30, 1=10+20+30+40=100
        assert_eq!(result.retained_sizes[4], 40);
        assert_eq!(result.retained_sizes[2], 20);
        assert_eq!(result.retained_sizes[3], 30);
        assert_eq!(result.retained_sizes[1], 100);
    }

    #[test]
    fn multiple_gc_roots() {
        // SuperRoot(0) -> 1, SuperRoot(0) -> 2
        // 1 -> 3, 2 -> 3
        let result = make_test(
            4,
            &[(1, 3), (2, 3)],
            &[1, 2],
            &[0, 10, 20, 30],
        );
        // 3 is reachable from both roots, so its dominator is root (0)
        assert_eq!(result.dominator_parent[3], 0);
        assert_eq!(result.dominator_parent[1], 0);
        assert_eq!(result.dominator_parent[2], 0);
    }

    #[test]
    fn dominator_children_populated() {
        let result = make_test(
            4,
            &[(1, 2), (2, 3)],
            &[1],
            &[0, 10, 20, 30],
        );
        assert!(result.dominator_children[0].contains(&1));
        assert!(result.dominator_children[1].contains(&2));
        assert!(result.dominator_children[2].contains(&3));
        assert!(result.dominator_children[3].is_empty());
    }

    #[test]
    fn unreachable_nodes_attached_to_root() {
        // Node 3 is unreachable (no edges to it)
        let result = make_test(
            4,
            &[(1, 2)],
            &[1],
            &[0, 10, 20, 30],
        );
        // Node 3 should be attached to root
        assert_eq!(result.dominator_parent[3], 0);
        assert!(result.dominator_children[0].contains(&3));
    }
}
