---
sidebar_position: 1
title: Install HeapLens
---

## VS Code and compatible editors

Install **HeapLens** by Sachin Gupta from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=guptasachinn.heaplens) or [Open VSX](https://open-vsx.org/extension/guptasachinn/heaplens). Confirm the identifier `guptasachinn.heaplens`.

1. Open Extensions, find HeapLens, and install it.
2. Open a completed local `.hprof` file. If another editor handles it, use **Reopen Editor With → HeapLens**.
3. Start with [Overview](../tabs-guide/overview-tab.md) and the [quick start](./quick-start.md).

The package includes a native analysis server. An existing dump needs no Rust, Node.js, source checkout, or running JVM. Capture and Monitor have separate JVM requirements.

The manifest declares VS Code `^1.74.0`; chat features additionally require the relevant host APIs. Compatible editor branding does not establish participant compatibility.

VS Code **1.0.34** adds **HeapLens: Analysis Initial Mode** (`heaplens.analysis.initialMode`). Set it to `shallow` before opening a new dump for Quick Scan, or leave `full` for the default. Quick Scan shows allocation counts and shallow sizes; **Analyze Retained** explicitly starts full analysis for other views. Quick Scan supports conventional HPROF 1.0.1 and 1.0.2 captures.

During full analysis, the editor first shows progress and partial record counts, then shallow Overview/Histogram results when available. References, reachable heap and retained sizes become available later; they are not inferred from those partial counts. Waste is calculated separately through **Calculate Waste**.

### Choose reference storage

Open the Command Palette and select **HeapLens: Configure Analysis Storage**, then choose **Memory storage** or **Disk-backed references**. The same choice is available as **HeapLens: Analysis Storage** in the graphical Settings editor. Memory storage is the default. No environment variables, JSON editing, or cache-path configuration are required.

Close and reopen existing dump editors after changing the choice. When full analysis completes, the status shows **References: memory**, or **References: disk · Index built/reused**. A first disk analysis builds a private local index; reopening a validated capture can reuse it. Quick Scan does not build a reference index. The choice is a user-level preference, not a project setting.

HeapLens manages the cache location on the extension-host machine: `~/Library/Caches/HeapLens/structure-v1` on macOS, `$XDG_CACHE_HOME/HeapLens/structure-v1` (or `~/.cache/HeapLens/structure-v1`) on Linux, and `%LOCALAPPDATA%/HeapLens/structure-v1` on Windows. Completed indices persist and may contain sensitive heap-derived information; they are not encrypted. Keep the capture and its cache unchanged while analyzing. Disk mode can be slower on first load, and indices can exceed the capture size. Nodes and exact dominators still need RAM: this is not a total-memory limit. The advanced reference-sort buffer setting is optional.

Quick Scan, progressive results, storage selection and on-demand Waste require the matching bundled server introduced with 1.0.34; they are not part of the older 1.0.33 package. See [resource and storage guidance](../runbook/performance-tuning.md).

## Native packages

Select the matching target from the [GitHub releases](https://github.com/sachinkg12/heaplens/releases). The VS Code packaging workflow builds these four native targets:

| Machine | VSIX target |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x64` |
| Windows x64 | `win32-x64` |
| Linux x64 | `linux-x64` |

For manual installation, download the matching VSIX and use **Extensions: Install from VSIX**. Other architectures are not covered by these packages. Artifact availability does not prove every feature was manually tested on each OS. Remote editors need the binary for the **extension-host machine**, not necessarily your laptop.

## Other hosts and privacy

IntelliJ has a [JetBrains Marketplace listing](https://plugins.jetbrains.com/plugin/35004-heaplens) and separately versioned Apple Silicon packages. Standalone portable/npm/Homebrew artifacts have a separate distribution process. A VS Code release does not publish those packages. Use [choose your host](./choose-host.md), [IntelliJ setup](./intellij.md), or [standalone setup](./standalone.md); do not guess public install commands.

Analysis is local. AI is optional and has a separate [sharing boundary](../ai-integration/privacy.md). [Telemetry](../runbook/telemetry.md) is independent: VS Code/standalone default to usage/errors subject to controls; IntelliJ requires approval. Turn it off before opening a dump if you want it off from the first operation.

[Contributor setup](../architecture/contributing.md) is separate from ordinary installation. See [troubleshooting](../runbook/troubleshooting.md) for missing binaries and recovery.
