---
sidebar_position: 1
title: Troubleshooting and recovery
---

import FlowDiagram from '@site/src/components/FlowDiagram';

## Native server missing or wrong target

For an installed extension, reinstall the correct OS/architecture package; confirm it contains the native server. Do not require ordinary users to compile Rust. On remote hosts match the **server machine**. Check file permissions, platform/security quarantine, and trusted artifact provenance before overriding a binary. Do not bypass security warnings for an untrusted executable.

Source contributors should use the documented build/staging flow from the repository root. See [installation](../getting-started/installation.md).

## Analysis is slow

Check the selected process's CPU/RSS and whether it still runs. Large graphs, disk faults, paging, and concurrent dumps can slow analysis. Continue Waiting is different from Retry. Cancel can stop work; wait for acknowledgement/exit before restarting.

A warning after several minutes is not evidence of a fixed hard analysis deadline. An RPC request timeout also differs from async analysis completion. See [memory guidance](./performance-tuning.md).

## Server exited

<FlowDiagram kind="recovery" />

Use Retry in the affected editor. It starts a replacement, reconnects object/query actions, and analyzes without closing the dump. Other open dumps should remain independent. If it fails, preserve the visible error and sanitized local diagnostics.

SIGKILL or exit 137 can be manual/external termination or memory pressure; it is not proof of OOM. Check OS evidence before assigning a cause. Successful Retry establishes recovery, not the original failure cause. Older releases without delivered Retry may need closing/reopening or updating.

## Blank editor or missing charts

Check renderer/host diagnostics separately. D3 is packaged locally, not loaded from a public CDN. Verify local assets, content-security rules, and the correct host bridge. IntelliJ additionally needs compatible JCEF/native packaging. Light/dark mismatch is a host theme issue, not heap-data failure.

## AI and source

Set/replace the provider's credential using host secret controls; Ollama is keyless by default. Check exact model ID/endpoint compatibility, access/rate limits, and explicit approval. Redact keys and private endpoints before sharing errors.

Source matches depend on project/version/tier. IntelliJ's broader library list is not VS Code's filtered candidate list. Fix with AI must resolve eligible project code independently; decompiled code is not automatically writable.

## Accuracy and empty views

Compare backend, size model, reachable versus total heap, reference policy, and same-class/cross-class aggregation before calling differing values wrong. Dominator percentage differences are [disclosed](../tabs-guide/dominator-tree-tab.md). No suspects/waste does not prove an application is healthy; filters and coverage matter.

For build/test failures, use [contributor setup](../architecture/contributing.md); avoid broad cleanup/destructive reset commands. Report a minimal sanitized reproduction through [support](./support.md).
