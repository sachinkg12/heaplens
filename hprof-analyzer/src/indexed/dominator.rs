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
    /// Total shallow size of unreachable nodes (not reachable from any GC root).
    pub unreachable_shallow_size: u64,
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
            unreachable_shallow_size: 0,
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
        use rayon::prelude::*;
        let retained_sizes: Vec<u64> = (0..n)
            .into_par_iter()
            .map(|i| node_store.get_by_index(i as u32).shallow_size as u64)
            .collect();
        let dominator_parent = vec![u32::MAX; n];
        let dominator_children = vec![Vec::new(); n];
        let unreachable_shallow_size: u64 = retained_sizes.iter().sum();
        return DominatorResult {
            retained_sizes,
            dominator_parent,
            dominator_children,
            unreachable_shallow_size,
        };
    }

    // Union-Find with path compression for ancestor queries
    let mut ancestor: Vec<u32> = vec![u32::MAX; n]; // ancestor in the forest
    let mut label: Vec<u32> = (0..n as u32).collect();   // label[v] = node with min semi on path

    // Implicit link: ancestor[w] = v means v is w's ancestor in the forest
    fn compress(v: u32, ancestor: &mut [u32], semi: &[u32], label: &mut [u32]) {
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
            if semi[label[a as usize] as usize] < semi[label[node as usize] as usize] {
                label[node as usize] = label[a as usize];
            }
            ancestor[node as usize] = ancestor[a as usize];
        }
    }

    fn eval(v: u32, ancestor: &mut [u32], semi: &[u32], label: &mut [u32]) -> u32 {
        if ancestor[v as usize] == u32::MAX {
            return v;
        }
        compress(v, ancestor, semi, label);
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
                let u = eval(v, &mut ancestor, &semi, &mut label);
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
            let u = eval(v, &mut ancestor, &semi, &mut label);
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

    // Initialize retained sizes from shallow sizes using rayon parallel collect
    use rayon::prelude::*;
    let mut retained_sizes: Vec<u64> = (0..n)
        .into_par_iter()
        .map(|i| node_store.get_by_index(i as u32).shallow_size as u64)
        .collect();

    // Process in reverse DFS order: children before parents.
    // First handle reachable nodes in reverse DFS order.
    for i in (1..reachable).rev() {
        let w = vertex[i] as usize;
        if dominator_parent[w] != u32::MAX {
            let p = dominator_parent[w] as usize;
            retained_sizes[p] += retained_sizes[w];
        }
    }

    // Unreachable nodes: not visited during DFS from GC roots.
    // Exclude unreachable nodes from retained size
    // computation entirely — they are already garbage and should not
    // inflate ancestor retained sizes or leak suspect percentages.
    let mut unreachable_shallow_size: u64 = 0;
    for i in 0..n {
        if dfnum[i] == u32::MAX && (i as u32) != root {
            unreachable_shallow_size += node_store.get_by_index(i as u32).shallow_size as u64;
            retained_sizes[i] = 0;
        }
    }

    DominatorResult {
        retained_sizes,
        dominator_parent,
        dominator_children,
        unreachable_shallow_size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed::edge_store::EdgeBuilder;
    use crate::indexed::node_store::{NodeStore, NodeType};
    use petgraph::algo::dominators;
    use petgraph::graph::{DiGraph, NodeIndex};
    use std::collections::VecDeque;
    use std::sync::Arc;

    #[derive(Debug)]
    struct OracleResult {
        dominator_parent: Vec<u32>,
        retained_sizes: Vec<u64>,
        unreachable_shallow_size: u64,
        reachable: Vec<bool>,
    }

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

    /// Deliberately simple fixed-point oracle for small test graphs. It shares
    /// no implementation with Lengauer-Tarjan: each node's dominator set is
    /// computed by repeatedly intersecting the dominator sets of its reachable
    /// predecessors.
    fn fixed_point_oracle(
        node_count: usize,
        edges: &[(u32, u32)],
        gc_roots: &[u32],
        shallow_sizes: &[u32],
    ) -> OracleResult {
        assert!(node_count > 0);

        let mut successors = vec![Vec::<usize>::new(); node_count];
        let mut predecessors = vec![Vec::<usize>::new(); node_count];
        let all_edges = gc_roots
            .iter()
            .map(|&root| (0, root))
            .chain(edges.iter().copied());

        for (source, target) in all_edges {
            let source = source as usize;
            let target = target as usize;
            assert!(source < node_count && target < node_count);
            successors[source].push(target);
            predecessors[target].push(source);
        }
        for list in successors.iter_mut().chain(predecessors.iter_mut()) {
            list.sort_unstable();
            list.dedup();
        }

        let mut reachable = vec![false; node_count];
        let mut queue = VecDeque::from([0usize]);
        reachable[0] = true;
        while let Some(source) = queue.pop_front() {
            for &target in &successors[source] {
                if !reachable[target] {
                    reachable[target] = true;
                    queue.push_back(target);
                }
            }
        }

        let mut dominators = vec![vec![false; node_count]; node_count];
        dominators[0][0] = true;
        for node in 1..node_count {
            if reachable[node] {
                for candidate in 0..node_count {
                    dominators[node][candidate] = reachable[candidate];
                }
            }
        }

        loop {
            let mut changed = false;
            for node in 1..node_count {
                if !reachable[node] {
                    continue;
                }

                let mut reachable_predecessors = predecessors[node]
                    .iter()
                    .copied()
                    .filter(|&predecessor| reachable[predecessor]);
                let first = reachable_predecessors
                    .next()
                    .expect("a reachable non-root node has a reachable predecessor");
                let mut next = dominators[first].clone();
                for predecessor in reachable_predecessors {
                    for candidate in 0..node_count {
                        next[candidate] &= dominators[predecessor][candidate];
                    }
                }
                next[node] = true;

                if next != dominators[node] {
                    dominators[node] = next;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        let mut dominator_parent = vec![u32::MAX; node_count];
        for node in 1..node_count {
            if !reachable[node] {
                // Preserve HeapLens's existing navigation convention.
                dominator_parent[node] = 0;
                continue;
            }

            let strict: Vec<usize> = (0..node_count)
                .filter(|&candidate| candidate != node && dominators[node][candidate])
                .collect();
            let immediate: Vec<usize> = strict
                .iter()
                .copied()
                .filter(|&candidate| {
                    strict
                        .iter()
                        .all(|&other| other == candidate || dominators[candidate][other])
                })
                .collect();
            assert_eq!(immediate.len(), 1, "node {node} has ambiguous dominators");
            dominator_parent[node] = immediate[0] as u32;
        }

        let mut retained_sizes = vec![0u64; node_count];
        for dominator in 0..node_count {
            if !reachable[dominator] {
                continue;
            }
            retained_sizes[dominator] = (0..node_count)
                .filter(|&node| reachable[node] && dominators[node][dominator])
                .map(|node| shallow_sizes.get(node).copied().unwrap_or(0) as u64)
                .sum();
        }
        let unreachable_shallow_size = (1..node_count)
            .filter(|&node| !reachable[node])
            .map(|node| shallow_sizes.get(node).copied().unwrap_or(0) as u64)
            .sum();

        OracleResult {
            dominator_parent,
            retained_sizes,
            unreachable_shallow_size,
            reachable,
        }
    }

    /// A second independent implementation (petgraph's Cooper-Harvey-Kennedy
    /// algorithm) checks immediate dominators on exactly the same graph.
    fn petgraph_parents(
        node_count: usize,
        edges: &[(u32, u32)],
        gc_roots: &[u32],
        reachable: &[bool],
    ) -> Vec<u32> {
        let mut graph = DiGraph::<(), ()>::new();
        let nodes: Vec<_> = (0..node_count).map(|_| graph.add_node(())).collect();
        for &root in gc_roots {
            graph.add_edge(nodes[0], nodes[root as usize], ());
        }
        for &(source, target) in edges {
            graph.add_edge(nodes[source as usize], nodes[target as usize], ());
        }

        let reference = dominators::simple_fast(&graph, NodeIndex::new(0));
        let mut parents = vec![u32::MAX; node_count];
        for node in 1..node_count {
            parents[node] = reference
                .immediate_dominator(nodes[node])
                .map(|parent| parent.index() as u32)
                .unwrap_or_else(|| if reachable[node] { u32::MAX } else { 0 });
        }
        parents
    }

    fn assert_matches_oracles(
        case: &str,
        node_count: usize,
        edges: &[(u32, u32)],
        gc_roots: &[u32],
        shallow_sizes: &[u32],
    ) {
        let actual = make_test(node_count, edges, gc_roots, shallow_sizes);
        let oracle = fixed_point_oracle(node_count, edges, gc_roots, shallow_sizes);
        let petgraph = petgraph_parents(node_count, edges, gc_roots, &oracle.reachable);

        assert_eq!(
            actual.dominator_parent, oracle.dominator_parent,
            "fixed-point mismatch for {case}; roots={gc_roots:?}; edges={edges:?}"
        );
        assert_eq!(
            actual.dominator_parent, petgraph,
            "petgraph mismatch for {case}; roots={gc_roots:?}; edges={edges:?}"
        );
        assert_eq!(
            actual.retained_sizes, oracle.retained_sizes,
            "retained-size mismatch for {case}; roots={gc_roots:?}; edges={edges:?}"
        );
        assert_eq!(
            actual.unreachable_shallow_size, oracle.unreachable_shallow_size,
            "unreachable-size mismatch for {case}; roots={gc_roots:?}; edges={edges:?}"
        );
    }

    #[derive(Clone, Copy)]
    struct DeterministicRng(u64);

    impl DeterministicRng {
        fn next_u32(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 32) as u32
        }
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

    #[test]
    fn cyclic_cross_edge_uses_semidominator_for_path_compression() {
        // Regression for a Lengauer-Tarjan path-compression bug. There are two
        // independent paths to node 2:
        //
        //   0 -> 1 -> 2
        //   0 -> 4 -> 2
        //        ^
        //        3 <- 1
        //
        // Therefore node 2 is immediately dominated by the super-root, not by
        // node 1. Comparing DFS numbers instead of semidominator numbers in
        // `compress` incorrectly makes node 1 the immediate dominator.
        let result = make_test(
            5,
            &[(1, 2), (1, 3), (3, 4), (4, 2)],
            &[1, 4],
            &[0, 10, 20, 30, 40],
        );

        assert_eq!(result.dominator_parent, vec![u32::MAX, 0, 0, 1, 0]);
        assert_eq!(result.retained_sizes, vec![100, 40, 20, 30, 40]);
    }

    #[test]
    fn second_cyclic_cross_edge_matches_two_independent_oracles() {
        assert_matches_oracles(
            "second cyclic counterexample",
            5,
            &[(1, 3), (2, 4), (3, 4), (4, 1)],
            &[2, 3],
            &[0, 11, 22, 33, 44],
        );
    }

    #[test]
    fn lengauer_tarjan_paper_topology_matches_two_independent_oracles() {
        // Nodes 1..13 are R,A,B,C,D,E,F,G,H,I,J,K,L. This is the graph
        // topology from the original Lengauer-Tarjan paper, expressed here
        // independently as an edge list.
        let edges = [
            (1, 2), (1, 3), (1, 4),
            (2, 5),
            (3, 2), (3, 5), (3, 6),
            (4, 7), (4, 8),
            (5, 13),
            (6, 9),
            (7, 10),
            (8, 10), (8, 11),
            (9, 6), (9, 12),
            (10, 12),
            (11, 10),
            (12, 10), (12, 1),
            (13, 9),
        ];
        let shallow_sizes: Vec<u32> = (0..14).map(|node| node as u32 * 7).collect();
        assert_matches_oracles(
            "Lengauer-Tarjan paper graph",
            14,
            &edges,
            &[1],
            &shallow_sizes,
        );
    }

    #[test]
    fn edge_order_duplicates_self_loops_and_unreachable_nodes_are_stable() {
        let canonical = [(1, 2), (1, 3), (2, 2), (2, 4), (3, 4), (4, 2)];
        let permuted_with_duplicates = [
            (4, 2), (1, 3), (2, 4), (1, 2), (2, 2), (3, 4),
            (1, 2), (4, 2),
        ];
        let shallow = [0, 10, 20, 30, 40, 50];
        let first = make_test(6, &canonical, &[1], &shallow);
        let second = make_test(6, &permuted_with_duplicates, &[1], &shallow);

        assert_eq!(first.dominator_parent, second.dominator_parent);
        assert_eq!(first.retained_sizes, second.retained_sizes);
        assert_eq!(first.unreachable_shallow_size, 50);
        assert_eq!(first.retained_sizes[5], 0);
        assert_matches_oracles(
            "duplicates, self-loop and unreachable node",
            6,
            &permuted_with_duplicates,
            &[1],
            &shallow,
        );
    }

    #[test]
    fn deterministic_generated_graphs_match_two_independent_oracles() {
        const GRAPH_COUNT: usize = 10_000;
        const SEED: u64 = 0x4845_4150_4c45_4e53;
        let mut rng = DeterministicRng(SEED);

        for case_index in 0..GRAPH_COUNT {
            let node_count = 2 + (rng.next_u32() as usize % 31);
            let root_count = 1 + (rng.next_u32() as usize % (node_count - 1).min(3));
            let mut gc_roots = Vec::with_capacity(root_count);
            while gc_roots.len() < root_count {
                let candidate = 1 + (rng.next_u32() as usize % (node_count - 1));
                if !gc_roots.contains(&(candidate as u32)) {
                    gc_roots.push(candidate as u32);
                }
            }

            let mut edges = Vec::new();
            for source in 1..node_count {
                for target in 1..node_count {
                    if rng.next_u32() % 100 < 14 {
                        edges.push((source as u32, target as u32));
                        if rng.next_u32() % 29 == 0 {
                            edges.push((source as u32, target as u32));
                        }
                    }
                }
            }
            let shallow_sizes: Vec<u32> = (0..node_count)
                .map(|node| if node == 0 { 0 } else { rng.next_u32() % 4096 })
                .collect();

            assert_matches_oracles(
                &format!("generated graph {case_index} seed {SEED:#x}"),
                node_count,
                &edges,
                &gc_roots,
                &shallow_sizes,
            );
        }
    }
}
