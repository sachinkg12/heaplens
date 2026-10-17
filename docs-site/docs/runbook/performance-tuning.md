---
sidebar_position: 3
title: Large dumps and analyzer memory
---

There is **no universal file-size-to-RAM multiplier** or maximum-file-size guarantee. Object/edge density, class/layout metadata, representation, temporary arrays, mapped pages, concurrent dumps, and available memory all matter.

A 25 GB capture is not guaranteed to fit a 64 GB machine. LIMIT, --rows, and collapsed tabs bound output/rendering, not the initial graph/dominator working set. Choose Memory or optional Disk storage for full analysis, or Quick Scan when only shallow results are needed.

## Choose the work you need

| Choice | Work and storage | Trade-off |
| --- | --- | --- |
| Full analysis, Memory | Builds a graph and dominators for this process; no reusable structural index | Often a faster first analysis when RAM is available; large live working structures |
| Full analysis, Disk first build | Writes a private structural index and maps graph/catalog columns | Extra writes, verification and free-space needs; mapped data still contributes to RAM use |
| Full analysis, Disk reopen | Verifies the capture and index, then recomputes dominators | Avoids rebuilding the structure, not all reads or computation |
| Quick Scan | Allocation counts and shallow histogram only; no reference index | No retained sizes, paths, graph queries or Waste until full analysis is requested |

Full-analysis editors show partial record counts and shallow results when those stages complete. This improves visibility but is not completion or a latency guarantee. **Calculate Waste** is separate; terminal analysis uses `--with-waste` when those estimates are needed.

Choose **HeapLens: Configure Analysis Storage** in VS Code, **Disk-backed references** in IntelliJ, or `--storage disk` in the CLI/browser. Memory remains the default. Restart the dump's analysis server after changing storage. See [storage details and cache locations](../api-reference/cli.md#disk-reference-storage).

## Resource admission

Full indexed analyses estimate working allocations from record counts and coordinate reservations across HeapLens processes on the same host. Admission considers available OS/container memory and reserves room for the host. It can reject another large analysis even when its file opens successfully. Close other dump editors or applications, then retry; a failure does not silently switch to Memory mode.

This is cooperative admission, not a hard memory cap. Other applications, mapped pages, page-cache changes, allocation overhead and later queries can still create memory pressure. Quick Scan has metadata/work limits rather than a full-analysis reservation. A 64 MiB edge buffer controls one scratch path, not total RAM.

## Disk space and cache lifetime

Keep free space for temporary construction files and the completed index; object-dense captures can produce indexes larger than the original file. Selective lossless encoding does not guarantee a compression ratio. Keep the original capture: indexes contain locations and relationships, not a replacement copy of its contents.

Completed indexes survive editor closure and changes back to Memory mode. Close every analysis using an entry before deleting that specific index. Old format entries remain on disk until removed. Failed or cancelled normal builds clean up unpublished temporary directories; forced termination can leave ignored partial directories. Do not edit a mapped capture or cache. Index metadata is sensitive and unencrypted; see [local-cache privacy](../ai-integration/privacy.md#local-structural-caches).

## Before analysis

Use local SSD storage, completed immutable captures, adequate free RAM/disk/swap, and a matching native target. Close unused dump tabs because each can own a resident graph. Begin with a smaller representative capture to observe memory/shape; extrapolation remains approximate.

Memory mapping avoids an eager buffer copy but still faults pages into RAM. Warm page caches can change repeat timings. Compression such as xz is not a random-access replacement for graph indexes; it needs a decompression/access design, not a filename extension swap.

## Observe one process

Use the PID displayed/logged for the selected dump, not a broad pgrep/pkill of all servers.

```bash
top -pid 12345
```

On Linux use `top -p 12345`; on Windows inspect that PID in Task Manager. Replace the number with the actual process. CPU/RSS patterns vary by backend/phase and do not prove completion. On macOS, physical footprint and RSS measure different things: mapped/reclaimable pages can make RSS much larger than the process's physical footprint. Label both rather than presenting them as interchangeable RAM measurements.

## Slow versus dead

Continue Waiting if the process is working and resources permit; Cancel if needed. Retry replaces an exited server, not the operating system's memory capacity. SIGKILL/137 alone does not prove OOM; correlate OS evidence. Avoid repeated retries under unchanged severe memory pressure.

## Measurements

[Previously recorded figures](./recorded-measurements.md) retain the original numbers and identify unresolved provenance. They are not fresh benchmarks, universal RAM ratios, or a latency SLA. Compare first Memory analysis, fresh Disk construction and Disk reopening separately. Record the exact package/binary, capture hash and object/edge shape, hardware/RAM/storage, cache preparation, time to shallow results, time to retained results, whether Waste was calculated, peak RSS/physical footprint, final index size, failures and repeated trials. Reopening an editor does not make the OS page cache cold; using a new index directory makes an index build fresh but does not make the input cold.

See [Rust architecture](../architecture/rust-backend.md) and [recovery](./troubleshooting.md).
