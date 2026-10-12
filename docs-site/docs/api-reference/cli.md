---
title: CLI command reference
---

Use `heaplens` for local terminal analysis and protected file exports, or `heaplens open` for the browser interface. Installation and platform availability are described in [standalone setup](../getting-started/standalone.md).

## Commands

Replace placeholder paths with real files. Quote paths containing spaces and pass the entire query as one argument.

```bash
heaplens analyze "/absolute/path/app.hprof" --telemetry off
heaplens query "/absolute/path/app.hprof" \
  "SELECT object_id, class_name, retained_size FROM instances ORDER BY retained_size DESC LIMIT 20" \
  --format json --telemetry off
heaplens compare "/absolute/path/before.hprof" "/absolute/path/after.hprof" \
  --format json --output "/absolute/path/new-comparison.json" --telemetry off
heaplens open "/absolute/path/app.hprof" --telemetry off
```

| Command | Result |
| --- | --- |
| `analyze HPROF` | Summary, histogram, class/object suspects, top retained objects and waste totals. |
| `query HPROF QUERY` | Read-only HeapQL results; `:path`, `:refs`, `:children` and `:info` use object IDs from that same dump. |
| `compare BASELINE CURRENT` | Current-minus-baseline summary/class/suspect/waste differences. |
| `open HPROF...` | Local browser interface. Keep the command running while investigating. |

Each terminal invocation loads its inputs separately. Compare drops the baseline graph before loading current, while retaining compact comparison data. This is not persistent indexing or bounded-memory analysis. Different JVM layouts, workloads or capture conditions can change sizes without establishing a leak.

## Terminal options

| Option | Behavior |
| --- | --- |
| `--format text\|json` | Human-readable output or a versioned JSON report; default is text. |
| `--rows N` | 1–10,000, default 100. Limits returned sections/pages, not engine allocations or query evaluation. |
| `--page N` | Query result page, starting at 1. |
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

Keep captures complete and immutable during analysis. There are no persistent disk indexes or configured total-memory budget. Full retained analysis requires graph construction; output limits do not avoid that work. Existing query pagination can materialize the result before slicing. For aggregate queries, use `--rows` to bound displayed output rather than SQL `LIMIT`, which can currently limit scanned aggregate input.
