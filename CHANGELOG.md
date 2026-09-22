# Changelog

All notable changes to HeapLens are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- LLM API keys now use VS Code SecretStorage, which delegates to the platform keychain, instead of the `heaplens.llm.apiKey` setting. The setting has been removed. Existing keys migrate automatically on first activation: the previous value is copied into SecretStorage and cleared from every configuration scope. Non-secret provider options remain in ordinary settings and are combined with the credential only at the point of use.

### Added

- `HeapLens: Set or Replace LLM API Key`, `HeapLens: Clear LLM API Key`, and `HeapLens: Show LLM API Key Status`. The status view reports whether the selected provider has a key and displays only a fixed mask plus the final four characters when the key is long enough. Saved keys are never revealed in full.
- Credential-store and LLM-client test suites, now run by `npm test` alongside the analysis-session tests. Extension tests: 15 to 31.

## [1.0.28]

### Fixed

- `ROOT_NATIVE_STACK` (0x04) and `ROOT_THREAD_BLOCK` (0x06) GC root records were discarded by both backends. An object rooted only by one of them was treated as unreachable: it disappeared from reachable heap, contributed nothing to retained size, and could not be found in the dominator tree, even though the collector would have kept it alive.

  Modern OpenJDK classifies Java locals as `ROOT_JAVA_FRAME`, JNI locals as `ROOT_JNI_LOCAL`, and held monitors as `ROOT_MONITOR_USED`, and does not appear to emit either of these tags through its ordinary paths. This fix is therefore defensive, for dumps from older JDKs, alternate virtual machines, and non-HotSpot producers that do emit them.

### Changed

- All GC root types now route through a single shared classifier rather than duplicated match arms that had drifted between the indexed and legacy backends.
- Rust library tests: 152 to 156.

### Added

- Regression coverage that constructs complete HPROF 1.0.2 byte streams containing real `0x04` and `0x06` root records, feeds them through the production parsers for both backends, and asserts that objects reachable only through those records become super-root children. Truncated variants assert both backends return errors rather than panicking.

## [1.0.27]

### Fixed

- Weak, soft, phantom, finalizer, and cleaner referents no longer count as ordinary strong object edges. Retained sizes, paths, and leak suspects now exclude objects reachable only through the JDK-declared `java.lang.ref.Reference.referent` field, while raw field inspection and unrelated fields named `referent` remain available.

  Measured on a JDK 21 fixture, reachable heap fell from 11,953,592 to 2,486,174 bytes, and the object retaining the weak payload dropped from 10,486,012 to 1,048,804 bytes. JDK-internal weak collections are corrected without being special-cased.

  Some retained sizes increase, which is expected: removing weak edges changes the shape of the dominator tree, so an object previously reachable by both a strong and a weak path gains a single dominator that absorbs it.

### Added

- Indexed and legacy regression coverage for JDK reference strength, inheritance, malformed metadata, ordinary same-named fields, unreachable retained-size handling, and raw referent inspection.
- Rust library tests: 144 to 152.

## [1.0.26]

### Added

- Classloader leak detection. Classloaders retaining at least 5% of reachable heap are reported as leak suspects, below the 10% threshold used for individual objects, because a leaking classloader is actionable at a smaller share of the heap. Each suspect names the accumulation point found by following the dominant ownership chain until memory fans out. Objects already explained by a reported classloader are excluded from individual suspects so the same memory is not reported twice.
- `heaplens.analysis.longRunningWarningMinutes`, which controls a non-destructive Continue Waiting or Cancel prompt. Set it to `0` to disable the prompt.
- Request correlation for analysis progress, completion, and cancellation messages, plus an explicit terminal `cancelled` status from the analyzer.
- First automated tests for the TypeScript extension, and a repair to the `npm test` script, which referenced a runner that did not exist.

### Fixed

- Long-running heap analyses no longer fail in the UI after a hard-coded five-minute deadline. The completion listener now remains active until the server reports completion, cancellation, failure, or the server process actually exits. Missed heartbeats no longer detach an analysis that may be temporarily starved by swapping.
- Retry and Cancel actions now use the same analysis lifecycle as the initial run, so retried results are not discarded.
- Cancellation results that arrive before the webview is ready are buffered and delivered after startup, so the Retry control remains available.
- Classloader identifiers recorded during parsing reached the analysis stage, where they had previously been collected and discarded.

## [1.0.25]

### Fixed

- Class-level retained sizes double-counted overlapping subtrees. The total was computed by summing the retained size of every instance of a class, so when two instances of the same class were in an ancestor/descendant relationship in the dominator tree their retained sets overlapped and the shared bytes were counted more than once. Class aggregates could exceed the reachable heap.

  Aggregation now performs a single depth-first walk of the dominator tree, attributing each object to its nearest enclosing ancestor of the same class, so every byte is counted exactly once. Applies to both the indexed and legacy backends.

### Changed

- Rust library tests: 130 to 136.

## [1.0.24]

### Fixed

- **Dominator tree: incorrect retained sizes for objects in cyclic reference structures.**
  The Lengauer-Tarjan path-compression step compared DFS numbers instead of semidominator
  values when selecting the minimum-semidominator vertex. This produced incorrect immediate
  dominators on graphs containing cycles and cross edges, which in turn inflated retained
  sizes and could misorder leak suspects.

  The defect only surfaced on specific cyclic topologies, so linear and tree-shaped object
  graphs were unaffected. In practice it was triggered by common JDK internal structures.
  Measured on a JDK 19 heap dump, retained sizes were over-reported by up to 10x:

  | Object | Before | After |
  |---|---:|---:|
  | `com.sun.jmx.mbeanserver.Repository` | 115,148 | 11,230 |
  | `com.sun.jmx.interceptor.DefaultMBeanServerInterceptor` | 115,536 | 11,618 |
  | `java.lang.invoke.MethodType$ConcurrentWeakInternSet` | 101,169 | 36,572 |
  | `java.util.concurrent.ConcurrentHashMap` | 101,113 | 36,556 |

  Dumps whose largest objects are held through simple ownership chains are unlikely to see
  a change in their top leak suspects. Dumps with cyclic structures near the top of the
  dominator tree will now report smaller, correct retained sizes.

### Added

- **Differential tests for dominator correctness.** Immediate dominators, retained sizes,
  and unreachable totals are now verified against two independent implementations: a
  fixed-point iterative dataflow computation derived directly from the definition of
  dominance, and petgraph's `simple_fast`. Coverage includes cyclic cross-edge topologies,
  the graph from the original Lengauer-Tarjan paper, deterministic generated graphs, and
  edge cases for duplicate edges, self-loops, and unreachable nodes.
- `hprof-analyzer/tests/fixtures/DominatorCounterexample.java`, a small program that
  produces a heap dump reproducing the cyclic structure described above.

### Changed

- Rust test suite grows from 125 to 130 library tests.

## [1.0.23]

### Fixed

- Corrected the extension description shown on the Marketplace (view count, throughput
  figures, and analysis timings now match measured values).

## [1.0.22]

### Changed

- README accuracy pass: eleven views listed (including Monitor), minimum VS Code version
  corrected to 1.74.0, and performance figures updated to measured values.
- Switched status badges to Open VSX, as the Marketplace badge endpoints were retired.
- Added a worldwide usage map.

## [1.0.21]

### Added

- Accumulation point detection in leak suspects.

### Changed

- Replaced external tool references in code comments with generic terms.

[1.0.24]: https://github.com/sachinkg12/heaplens/releases/tag/v1.0.24
[1.0.23]: https://github.com/sachinkg12/heaplens/releases/tag/v1.0.23
[1.0.22]: https://github.com/sachinkg12/heaplens/releases/tag/v1.0.22
[1.0.21]: https://github.com/sachinkg12/heaplens/releases/tag/v1.0.21
