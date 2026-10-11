# Shallow-size model

HeapLens reports **estimated JVM object sizes**, not HPROF payload lengths.
The default model is `conventional-jvm-v1`. It is shared by the indexed and
legacy backends, including Phase 1, histograms, dominators, HeapQL, summaries,
incident reports and shallow-size inputs to waste estimates.

## Model and boundaries

`object_layout.rs` owns arithmetic; `hprof_sizing.rs` adapts HPROF metadata and
infers a layout. Graph builders consume that boundary. The model is derived from
HotSpot's documented object-layout rules and validated against sizes the JVM
itself reports through `Instrumentation.getObjectSize`. Comparisons with other
analyzers are recorded as secondary evidence; they are not the source of the model.

- An ordinary instance is the estimated object header plus primitive-field
  bytes and reference slots across its complete superclass chain, rounded to
  object alignment. Intermediate superclass extents are not independently
  padded: that would count gaps that modern HotSpot can reuse. This is a packed
  field estimate, not a reconstruction of every JVM's field-offset algorithm.
- An array includes the object header, a four-byte length, element-base
  alignment, elements, and final object alignment. References use the inferred
  reference width, not the serialized HPROF ID width. Wide primitive elements
  are aligned to eight bytes even under a 32-bit layout.
- Byte arithmetic and stored shallow sizes are 64-bit. Array payloads above
  4 GiB no longer wrap a 32-bit multiplication or lose bytes in node storage.
- Structural class-definition nodes and synthetic roots retain zero shallow
  size. Hidden VM fields, class-mirror/native metadata, special field padding
  (including `@Contended`) and compact object headers are not reconstructed.
  Total heap is therefore an estimate over represented instances and arrays,
  not complete JVM process memory or a guarantee of cross-tool total-heap equality.
- If class metadata is incomplete, the fallback is header plus serialized
  instance bytes, aligned. That fallback can overestimate compressed references.
  Cyclic superclass metadata returns a structured error.
- Android HPROF 1.0.3 retains the previous `legacy-payload-v0` estimate. Android
  sizing is deliberately parked; conventional HotSpot headers are not imposed
  on ART. It is tracked separately.

## Inference, assumptions and explicit layouts

The HPROF identifier width supplies the initial machine-word assumption.
Object-array and primitive-array address intervals rule out candidate
reference/class-pointer widths that would overlap the next observed object.
These widths are independent. Contradictory intervals are ignored. Ambiguous
cases choose the larger still-feasible widths; absence of evidence does not
prove that compression is disabled. Record order can affect available evidence.

Alignment is inferred from address differences without storing or sorting a
second list of object addresses. It is bounded to powers of two from 8 through
256. Fewer than 32 observed objects use the conservative 8-byte default.
Addresses must behave like physical heap addresses for these inferences to be
meaningful. Synthetic IDs, sparse dumps and unusual producers can be ambiguous.

Known producer options can bypass inference through `ObjectLayout::new` and
`build_graph_with_layout` / `parse_indexed_with_layout` /
`parse_indexed_phase1_with_layout`. The extension uses automatic inference;
there is no new user setting or silent environment-variable override.

Every parsed summary adds optional `size_model` metadata with `estimated`,
the model name, layout parameters, source, and incomplete-class count. Existing
fields remain JSON numbers with unchanged names. Old summaries can omit this
metadata. Overview and reports identify estimates. Both inference and explicit
layouts remain estimates because field offsets are not encoded in HPROF.

Do not compare old payload-only totals against new modeled totals as evidence
of application growth. Reanalyze both snapshots with the same HeapLens version
and model. Rust library consumers passing `u32` shallow sizes to node constructors
must widen them to `u64`; the extension's JSON schema remains compatible with
existing consumers, with one additive optional summary field.

## Validation

Run `cargo test --release --lib --bins --tests` (includes the separate
`shallow_size` parser tests). Coverage includes all primitive widths, zero and
odd lengths, 4/8-byte file IDs, independent pointer widths, 8/16/32-byte object
alignment, inherited fields and late class records, malformed array bodies,
cyclic and missing metadata, generated arithmetic cases, and >4 GiB calculations.

`tests/fixtures/ShallowSizeCounterexample.java` is a small Java agent and fixture
generator. Its `Sample` objects store `Instrumentation.getObjectSize(value)`
alongside each object reference. From `hprof-analyzer`, with a JDK on PATH:

```sh
oracle_dir=$(mktemp -d)
javac -d "$oracle_dir/classes" tests/fixtures/ShallowSizeCounterexample.java
jar cfm "$oracle_dir/oracle.jar" tests/fixtures/shallow-size-agent.mf -C "$oracle_dir/classes" .
java -Xmx128m -javaagent:"$oracle_dir/oracle.jar" -cp "$oracle_dir/classes" ShallowSizeCounterexample "$oracle_dir/layout-default.hprof"
cargo run --release --example size_oracle -- "$oracle_dir/layout-default.hprof"
```

Repeat with a fresh output filename and VM flags for independent pointer widths
(`-XX:-UseCompressedOops`, `-XX:-UseCompressedClassPointers`, or both) and
`-XX:ObjectAlignmentInBytes=16`. The generator prints the actual VM options.
Run `examples/size_oracle.rs` on an existing fixture as follows:

```sh
cargo run --release --example size_oracle -- /absolute/path/layout-default.hprof
```

This checks every recorded expected size through both graph backends. It exits
nonzero on a mismatch; `--allow-deltas` is only for investigating old versions.
The `audit_heap` example measures full analysis, reports summaries and waste,
and fingerprints reachable instance/array sizes for corpus comparisons.
It also emits complete waste details so existing backend reporting differences
can be distinguished from object-size disagreements. The separate lightweight
`scan_records` payload-counting utility is not a full graph/layout analysis.

Other analyzers can be checked against the same fixture, since each `Sample`
carries the JVM-reported size beside the object. Analyzers and the JVM can
disagree, particularly when reference and class-pointer compression differ or
subclass fields reuse padding. Preserve those differences as evidence rather
than forcing HeapLens to reproduce them. Detailed measured results and release
gates are kept in the project's evidence records.
