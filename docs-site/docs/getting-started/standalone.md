---
title: Standalone CLI and browser
---

Analyze an existing dump without an IDE. The native CLI and local browser host are implemented. Current portable/npm/Homebrew artifacts are **Apple Silicon release candidates**; do not assume a public package name exists.

## Install a candidate

Use a trusted generated portable archive, npm archive, or tested candidate formula. Verify the checksum/candidate manifest; licenses and third-party notices are bundled.

For the npm candidate, use native ARM64 Node **22+**:

```bash
npm install --global /absolute/path/to/generated-package.tgz
heaplens --version
heaplens --help
```

The npm launcher requires Node 22+ even for terminal commands. A portable native binary can run terminal analysis without Node; browser mode still needs Node. Use native ARM64 Node on Apple Silicon, not an Intel Node installation running under Rosetta. This package is not an installer for other operating systems or CPU architectures.

## Terminal only

Replace placeholder paths with real files and quote spaces:

```bash
heaplens analyze "/absolute/path/app.hprof" --telemetry off
heaplens query "/absolute/path/app.hprof" \
  "SELECT object_id, class_name, retained_size FROM instances ORDER BY retained_size DESC LIMIT 20" \
  --telemetry off
heaplens compare "/absolute/path/baseline.hprof" "/absolute/path/current.hprof" \
  --format json --output "/absolute/path/new-comparison.json" --telemetry off
```

`--format json` emits a versioned report. `--output` and `--diagnostics` require **new writable files**, never overwrite, and reports are bounded to 8 MiB. `--rows` (1–10,000, default 100) bounds output, not analysis RAM. Query `--page` starts at 1. CLI query integer cells use decimal strings; native JSON-RPC still uses numbers.

Results go to stdout, progress/errors to stderr. `--quiet` suppresses progress only. Exit codes: 0 success, 2 usage/configuration, 3 input, 4 heap analysis, 5 query, 6 output failure. Each command loads separately; Compare releases the baseline graph before loading current and compares compact results.

## Browser with all eleven views

```bash
heaplens open "/absolute/path/app.hprof" \
  --source-root "/absolute/path/java-project/src" --telemetry off
```

Keep the terminal running. The host binds **loopback only**; its private URL grants session access—do not share it. Ctrl+C stops owned processes. `--no-browser` prints the URL without opening a desktop browser. `--port 0` picks a free port. Up to eight supplied dumps can have independent tabs.

The browser offers views, HeapQL, downloads, local source viewing, and optional AI. Source stays within supplied roots; no IDE decompiler/dependency-JAR lookup. AI credentials last for the running host session. Source sends require approval; proposals do not silently overwrite originals. Monitor needs a separately configured agent. See [browser actions and controls](./browser.md) and the [CLI command reference](../api-reference/cli.md).

## Checkout versus package

A native checkout binary alone does not include built browser assets. Contributors must build the browser host and supply valid host/server paths, or test a complete candidate. `/path/app.hprof` is not an actual fixture. See [contributor setup](../architecture/contributing.md).

[Telemetry](../runbook/telemetry.md) defaults on: use `--telemetry off` every time or `DO_NOT_TRACK=1`. AI has a separate [privacy boundary](../ai-integration/privacy.md).
