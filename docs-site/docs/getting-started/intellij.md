---
title: IntelliJ setup
---

Install HeapLens from its [JetBrains Marketplace listing](https://plugins.jetbrains.com/plugin/35004-heaplens), or use a trusted release ZIP for manual installation. The plugin targets **macOS Apple Silicon and IntelliJ IDEA 2026.1–2026.2**. IntelliJ plugin versions are independent of VS Code versions; select the version and compatible IDE range shown for your package.

In **Settings → Plugins → Marketplace**, search for HeapLens and confirm its publisher. If you are testing a newer ZIP, follow the manual steps below. A VS Code release or repository push does not automatically upload or approve an IntelliJ update.

## Install from disk

1. Check the package's macOS Apple Silicon target and compatible IDE range. The current package supports IntelliJ IDEA 2026.1–2026.2.
2. In **Settings → Plugins**, use **Install Plugin from Disk** in the gear menu and select the ZIP.
3. Restart if requested, open the source project, and open a completed `.hprof`.
4. Verify Overview, a HeapQL query, and a project-source action before a large dump.

A release ZIP bundles its server. **Select analysis server** is a trusted-binary override/development aid, not required for ordinary installation. Use an IDE with JCEF for the embedded interface; project Java source navigation also needs the appropriate Java support.

## Reference storage

Select **Disk-backed references** in the HeapLens toolbar to use reusable local structural indexes. Memory storage remains the default. The checkbox configures newly started analysis servers; after changing it, close and reopen the dump. It also sets the default for subsequently opened dumps. It does not change a running graph.

Disk mode stores private, reusable structural indices in the platform cache directory. The status bar shows `references: disk` and `cache: built` or `cache: reused`. Reopening validates the dump and all index components before reuse. Exact dominators and node metadata still use RAM; the option is not a total-memory limit. Quick Scan remains shallow until Analyze Retained is requested. See [disk reference storage](../api-reference/cli.md#disk-reference-storage) for disk-space, privacy, corruption, cleanup and immutability requirements.

## Source, AI, and telemetry

Project Java files, attached dependency sources, and the IDE decompiler are supported lookup tiers. Libraries must belong to the project; no automatic downloads. Inner classes open their containing file, not a guaranteed exact declaration.

Fix with AI can resolve **project source independently**, without View Source first. Dependency/decompiled code is not editable project source. Approve full-file submission and destination, then review the proposal/apply/Undo controls. See [Source](../tabs-guide/source-tab.md).

Configure AI through **Configure AI**; credentials use the password-safe adapter. [Telemetry](../runbook/telemetry.md) requires separate approval and starts off.

## Using the plugin

Select **Quick Scan first** in the HeapLens toolbar before opening another dump to begin with shallow analysis. This local preference applies to newly opened editors; changing it does not restart the current analysis. Full analysis remains the default. After completion or Cancel, **Quick Scan** starts a new shallow session for the current dump.

Quick Scan provides allocation totals and a filtered, paged shallow histogram with local CSV export. Reachable heap and retained values are **Not calculated**, not zero. **Analyze Retained** explicitly runs a fresh full analysis before graph-dependent views, queries, source and AI actions are available. Retry repeats the selected mode. The scan supports conventional HPROF 1.0.1 and 1.0.2; unsupported captures fail without silently starting full analysis. A scan is not a configured total-memory budget.

Full analysis displays progress and shallow results as they become available; reference and retained analysis continue before graph-dependent actions unlock. Use **Calculate Waste** after full analysis to request content-based estimates. These controls require a plugin ZIP containing the matching new server and webview; older Marketplace versions may not expose them.

Each open dump has its own analysis session. Closing one leaves the others open. If analysis fails or its server exits, use Retry for that dump; Cancel requests cancellation of an active analysis. Exports use local clipboard or save controls. Review sensitive data before sharing a report, and read [troubleshooting](../runbook/troubleshooting.md) for recovery guidance.
