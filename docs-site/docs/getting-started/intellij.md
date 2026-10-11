---
title: IntelliJ setup
---

The adapter is implemented, but a repository merge is not Marketplace approval. Current packaging is a **macOS Apple Silicon candidate**. Use a project-provided trusted ZIP, not a VSIX.

## Install from disk

1. Verify candidate version, architecture, source commit, and compatible IDE build range. Apple Silicon packaging targets IntelliJ 2026.1+; do not assume an earlier prototype's range applies.
2. In **Settings → Plugins**, use **Install Plugin from Disk** in the gear menu and select the ZIP.
3. Restart if requested, open the source project, and open a completed `.hprof`.
4. Verify Overview, a HeapQL query, and a project-source action before a large dump.

A packaged candidate bundles its server. Select analysis server is a trusted-binary override/development aid, not required for correct packaging. JCEF/Java support must be available as required by the candidate.

## Source, AI, and telemetry

Project Java files, attached dependency sources, and the IDE decompiler are supported lookup tiers. Libraries must belong to the project; no automatic downloads. Inner classes open their containing file, not a guaranteed exact declaration.

Fix with AI can resolve **project source independently**, without View Source first. Dependency/decompiled code is not editable project source. Approve full-file submission and destination, then review the proposal/apply/Undo controls. See [Source](../tabs-guide/source-tab.md).

Configure AI through **Configure AI**; credentials use the password-safe adapter. [Telemetry](../runbook/telemetry.md) requires separate approval and starts off.

## Candidate acceptance

Test independent dump tabs, closing one, Cancel/Retry, a killed per-tab server and recovery, theme switching, queries/errors, source tiers, AI proposal apply/Undo, exports, and telemetry withdrawal. Use the same backend/version/dump for byte comparisons. Cross-platform testing and Marketplace publication remain separate steps.
