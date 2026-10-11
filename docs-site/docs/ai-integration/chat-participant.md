---
sidebar_position: 3
title: VS Code chat participant
---

HeapLens registers `@heaplens` using the **VS Code chat-participant API**. This is separate from the built-in AI Chat tab and from MCP.

## Use it

With a host exposing the chat and language-model APIs and appropriate model access, open a dump, then mention `@heaplens` in the supported editor chat surface. Ask about the active analysis or an investigation query.

The current participant implementation **prefers GPT-4o and otherwise uses the first available model**. It does not guarantee it uses the model selected in an editor dropdown. Model entitlement and provider processing are governed by that editor route.

## Scope

Registration in the VS Code API does not register a participant in every extension's independent chat panel. Cline, other coding agents, and compatible editors must be checked for their actual integration. Use [MCP](../mcp/setup.md) for a client that supports local stdio tools; do not assume a participant mention works in its own UI.

| Built-in tab | Participant |
| --- | --- |
| Ten configured provider presets and custom model IDs | Editor language-model API |
| HeapLens-owned credential configuration | Editor/model entitlement |
| Host-specific history and consent | Editor chat policy and participant behavior |

The minimized participant context omits raw duplicate-string previews and primitive field contents, but still includes names and analysis metadata. User-entered text is not redacted. These are privacy limits, not anonymity guarantees. See [AI privacy](./privacy.md).
