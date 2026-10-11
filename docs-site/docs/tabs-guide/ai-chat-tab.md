---
sidebar_position: 11
title: AI Chat
---

Configure a provider, choose a model ID, then ask a question. Stop cancels the active stream; Clear clears the visible chat according to host controls. Approval/configuration and history lifetime differ by host.

## Useful questions

- Which large objects should I inspect, and which assumptions remain unknown?
- Give a bounded HeapQL query to find the largest instances.
- Explain the difference between storage type and retaining owner.

Minimized prompts include summary/counts/sizes, class/field names, descriptions, and reference metadata, **not raw duplicate-string previews or primitive contents**. User-entered text/history is not redacted. Top-N context is incomplete.

## Verify the response

Inline Run Query actions, where offered, populate/run a proposed query through the host; review syntax and bounds first. Queries are read-only but can be costly. AI can propose unsupported syntax, double-count retained totals, or confuse resource closure with releasing buffers.

Same dump does not imply same answer: model, prompt/context, history, and provider settings can differ. Current VS Code follow-up context can omit its initial heap injection; verify against actual UI/query evidence instead of promising every turn is grounded.

## Session and sharing

IntelliJ/browser session approval is distinct from full-source confirmation. VS Code source submission asks per Fix request. History storage/export is host-specific, not a universal durable memory feature. Credentials use SecretStorage/password-safe/session memory respectively.

Do not type secrets. Local endpoints may forward remotely. See [provider setup](../ai-integration/api-key-setup.md), [privacy](../ai-integration/privacy.md), and [Source](./source-tab.md) before Fix with AI.
