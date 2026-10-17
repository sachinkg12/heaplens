---
title: CLI command reference
---

Use `heaplens` for local terminal analysis and protected file exports, or `heaplens open` for the browser interface. Installation and platform availability are described in [standalone setup](../getting-started/standalone.md).

## Commands

Replace placeholder paths with real files. Quote paths containing spaces and pass the entire query as one argument.

```bash
heaplens analyze "/absolute/path/app.hprof" --telemetry off
heaplens scan "/absolute/path/app.hprof" --format json --telemetry off
heaplens query "/absolute/path/app.hprof" \
  "SELECT object_id, class_name, retained_size FROM instances ORDER BY retained_size DESC LIMIT 20" \
  --format json --telemetry off
heaplens compare "/absolute/path/before.hprof" "/absolute/path/after.hprof" \
  --format json --output "/absolute/path/new-comparison.json" --telemetry off
heaplens open "/absolute/path/app.hprof" --telemetry off
```

| Command | Result |
| --- | --- |
| `analyze HPROF` | Summary, histogram, class/object suspects and top retained objects. Waste totals are included when calculated. |
| `scan HPROF` | Shallow allocation summary and class histogram, without a reference graph or retained analysis. |
| `query HPROF QUERY` | Read-only HeapQL results; `:path`, `:refs`, `:children` and `:info` use object IDs from that same dump. |
| `compare BASELINE CURRENT` | Current-minus-baseline summary/class/suspect/waste differences. |
| `open HPROF...` | Local browser interface. Keep the command running while investigating. |

Each terminal invocation loads its inputs separately. Compare drops the baseline graph before loading current, while retaining compact comparison data. Memory mode rebuilds the graph; Disk mode can reuse validated structural indexes. Cooperative resource admission coordinates estimated reservations across full-analysis processes, but neither mode imposes a hard total-process memory limit. Different JVM layouts, workloads or capture conditions can change sizes without establishing a leak.

## Shallow scan

Use `scan` when you need allocation counts and modeled shallow sizes without computing retaining references, dominators or Waste. It supports conventional HPROF 1.0.1 and 1.0.2 captures. Existing full-analysis commands continue to handle their supported formats; quick scan does not reinterpret Android layouts.

The JSON envelope's `data` identifies `analysis_scope: shallow` and reports graph-dependent readiness as `not_calculated`. Reachable heap is `null`, and histogram rows omit retained sizes. These missing results do not mean zero retained memory or no leaks.

Counts concern allocation records; duplicate object IDs and reference targets are not validated. `declared_classes` counts declared or loaded class IDs and is distinct from the full graph's class-node count. Shallow totals still use the shared estimated size model, including its incomplete-class warnings.

The scanner does not keep an object index, copy instance bodies or array references, or hash heap-string contents. It makes several metadata passes and retains class metadata and histogram groups. Default work limits are 250,000 class IDs/groups, two million instance-field descriptors, 64 KiB per requested metadata name and 32 MiB of decoded requested names. These are not a total RAM limit. `--rows` limits output, not scanning work. Graph-backend selection does not apply; `--backend legacy` is rejected for `scan`.

Use `analyze` separately when you want retained results. Scanning does not automatically start it. Older standalone candidates without the `scan` command require a new build.

## On-demand Waste

Indexed structural analysis leaves Waste uncalculated by default. Pass `--with-waste` to request it:

```bash
heaplens analyze "/absolute/path/app.hprof" --format json --telemetry off
heaplens analyze "/absolute/path/app.hprof" --with-waste --format json --telemetry off
```

The first report has `waste_status: not_calculated` and `waste_totals: null`. The second explicitly requests Waste and returns its totals. Missing results do not mean zero waste. Older builds and the legacy backend may calculate Waste during analysis. Terminal `compare` still requests Waste for both inputs so its Waste differences are complete.

The indexed file-backed parser records byte/char-array locations instead of hashing their contents during structural analysis. On request, it hashes recognized String backing arrays, not unrelated primitive buffers. Borrowed-byte library parsing retains its existing eager behavior. Keep the original HPROF unchanged while any mapped analysis remains open.

Lazy Waste separates work; it is independent of the optional disk reference storage below and does not guarantee that a large dump fits a particular machine.

## Disk reference storage

Memory mode remains the default. Disk mode uses bounded reference-construction buffers and mapped forward/reverse CSR columns. It saves structural metadata and instance field locations for reuse; it does not save raw primitive-array contents or duplicate-string previews. Quick Scan does not construct or load these indexes.

```bash
heaplens analyze "/absolute/path/app.hprof" --storage disk \
  --edge-buffer-mib 64 --format json --telemetry off
heaplens open "/absolute/path/app.hprof" --storage disk --telemetry off
```

Analyze and Query JSON data expose `storage.mode` and `storage.cache_status`: `built`, `reused`, or `disabled`. The browser uses the same server policy. On reuse, HeapLens verifies every byte of the dump and all cache components, plus schema and engine version. BLAKE3 uses a bounded verification pool, and the digest algorithm is recorded in the cache manifest. No sampled-file keys or unchecked component reuse are used. The full capture is still read for fingerprinting and dominators are recomputed; cold-disk reads do not disappear. Reopen is not guaranteed to be faster for every workload.

A cache format or digest change causes a new index build. Existing indices from a previous format are left unchanged, not converted or silently reused. No additional user setting is required.

The default cache is `~/Library/Caches/HeapLens/structure-v1` on macOS, `%LOCALAPPDATA%\HeapLens\structure-v1` on Windows, and `$XDG_CACHE_HOME/HeapLens/structure-v1` or `~/.cache/HeapLens/structure-v1` on Linux. `--cache-dir` selects an absolute private directory. Existing Unix directories must have private permissions; HeapLens does not change an existing directory's permissions. Windows access protection depends on directory ACLs. Index files contain sensitive heap metadata and are not encrypted.

Bulk metadata uses versioned binary columns with a shared string dictionary. Node, object-body and array catalogs are mapped; suitable body/array columns use block-wise lossless encoding and bounded sequential writing rather than a second full expanded copy. This is selective encoding, not compression of the whole dump. Checksums are calculated while writing, and persisted components are independently verified before the complete directory is published by an atomic rename. Reuse still verifies all component bytes. A format upgrade builds a new entry on first open; previous entries are preserved. The cache directory name is not the format version.

The edge buffer defaults to 64 MiB and accepts 1–1024 MiB. It controls the reference-sort scratch path, not every allocation. Metadata decoding, ID lookup construction, dominator working arrays/children and some HeapQL result materialization still use RAM. Mapped pages and OS file caches also contribute to memory use. Full-analysis admission estimates these needs and coordinates reservations across HeapLens processes using OS memory availability. Reservations remain estimates, not an enforced RSS limit or proof that a 25 GB dump fits 64 GB RAM. See [resource guidance](../runbook/performance-tuning.md).

Disk mode can be slower on a first load and needs free disk space for sorted runs plus permanent indices. Corrupt/incomplete published entries are rejected without deletion or a memory-mode fallback. Use a new private cache directory or remove only the rejected HeapLens entry after closing all processes using it. Interrupted unpublished directories are ignored; a forced process termination can leave them for manual cleanup. Closing an editor does not remove completed reusable indices. Never modify the original capture or mapped cache files while analysis is open. Keep the `.hprof`; indices do not replace it.

The stdio server accepts the same `--storage`, `--cache-dir`, and `--edge-buffer-mib` options. Shared environment defaults are `HEAPLENS_STORAGE`, `HEAPLENS_CACHE_DIR`, and `HEAPLENS_EDGE_BUFFER_MIB`; explicit options override their corresponding values. Disk mode is available only with the indexed backend. Quick Scan does not construct or load structural indices.

## Terminal options

| Option | Behavior |
| --- | --- |
| `--storage memory\|disk` | Indexed reference storage; default memory unless set through the environment. |
| `--cache-dir DIRECTORY` | Absolute private disk-index directory. |
| `--edge-buffer-mib N` | Disk sorting buffer, 1–1024 MiB; not total process memory. |
| `--format text\|json` | Human-readable output or a versioned JSON report; default is text. |
| `--rows N` | 1–10,000, default 100. Limits returned sections/pages, not engine allocations or query evaluation. |
| `--page N` | Query result page, starting at 1. |
| `analyze --with-waste` | Explicitly include content-based Waste in an indexed terminal analysis. |
| `--backend indexed\|legacy` | Select the analysis backend; default is indexed. |
| `--quiet` | Hide progress, not errors. Results use stdout; progress and errors use stderr. |
| `--output NEW_FILE` | Write to a new file. Existing files, symlinks and hardlink aliases are rejected. |
| `--telemetry off\|error\|all` | Per-invocation choice; default is all. `DO_NOT_TRACK=1` or `CI` disables ordinary reporting. |
| `--diagnostics NEW_FILE` | Save filtered local diagnostics without automatically uploading them or changing telemetry permission. |

Use `--output` rather than shell redirection when you need overwrite protection. The shell opens or truncates a redirection target before HeapLens runs. New Unix output files use mode 0600; Windows protection depends on the destination directory. No output directory is created automatically. An interrupted or failed write may leave a partial new file.

JSON reports are capped at 8 MiB; an oversized report fails instead of silently dropping sections. Object IDs and integer query cells are decimal strings to preserve their full width. Other report counts/bytes remain JSON integers, so consumers must preserve integer precision. Floating-point query results may be approximate.

The JSON envelope identifies its schema, command, outcome, backend, elapsed time, privacy projection, warnings and data. Selection totals and truncation are explicit. Runtime JSON errors go to stderr; argument-parser errors use the normal usage/error format.

## Browser options

| Option | Behavior |
| --- | --- |
| `--source-root DIRECTORY` | Approve local Java source lookup within the supplied root; repeat for additional roots. |
| `--no-browser` | Print the private launch URL without opening a desktop browser. |
| `--quick-scan` | Start browser dump sessions with shallow totals and histogram only. Analyze Retained explicitly starts full analysis. |
| `--port N` | Local port; zero chooses an available port. |
| `--server PATH` | Select a trusted analysis-server executable. |
| `--node PATH` | Select the Node executable. |
| `--ui-host PATH` | Select a trusted browser-host entry point with its adjacent assets. |

Browser mode has its own downloads and optional AI controls. `--output` and terminal JSON reports are not browser export controls. Read [the browser guide](../getting-started/browser.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed, help/version displayed, or the stdout consumer closed its pipe. |
| 2 | Invalid arguments, query length or page/row configuration. |
| 3 | Missing, unreadable, empty or non-regular input; browser-host setup failure. |
| 4 | Malformed, incomplete or unsupported heap, or unsupported comparison range. |
| 5 | HeapQL parsing or execution failure. |
| 6 | Existing/unwritable output or report-size limit. |

Crashes and OS termination use operating-system exit behavior, not fabricated success. Ctrl+C stops the process; rerun a terminal command to analyze again.

## Privacy and resource limits

Terminal commands do not make LLM requests or modify source. Reports omit raw heap-string previews, primitive contents, source bodies and input paths, but class/field names, descriptions and object metadata can still be sensitive. Argument-parser errors can repeat user-supplied arguments. A coding agent reading a report may transmit it under its own policy.

Telemetry is enabled by default. Use `--telemetry off` on each command for local analysis without telemetry requests. Optional browser AI has separate approvals. See [telemetry](../runbook/telemetry.md) and [AI privacy](../ai-integration/privacy.md).

Keep captures complete and immutable during analysis. Optional disk indexes persist structural data, not a complete retained-analysis result. Full analysis still needs a reference graph and dominator computation. Cooperative admission is not a configurable hard total-memory limit; output limits do not avoid graph work. Existing query pagination can materialize the result before slicing. For aggregate queries, use `--rows` to bound displayed output rather than SQL `LIMIT`, which can currently limit scanned aggregate input. Older standalone packages may lack the new commands/options; check their bundled help.
