---
sidebar_position: 3
title: Copilot Chat participant
---

The updated local VS Code implementation registers `@heaplens` through the editor's chat-participant API. It uses the model selected in that request, without a preferred-provider fallback. Compatible editor/model access is required. This is separate from the built-in AI Chat tab and MCP.

Open a dump, finish retained analysis, select a model and ask `@heaplens` a question. Each question requires approval to send bounded metadata and your text to that model. Up to four model calls and three read-only engine reads can occur; charges may apply. Raw heap contents, source and local paths are excluded, but names and questions can be sensitive.

The question captures the originating dump and generation. Changing focus does not retarget active work. Stop, Clear, Retry, server death or closing that dump cancels local work; previously transmitted data cannot be recalled.

## Answers and history

HeapLens accepts conversational answers and, when the selected editor model advertises tool support, bounded native tool requests. Tool arguments and scope are checked before engine access. Evidence buttons open actual records; old analysis handles expire. AI prose and suggested fixes remain unverified, even when they cite a valid record. No fallback model is selected silently.

Only completed turns associated with a private completion token, the same analysis and selected model become follow-up context. Arbitrary editor history and restored display-only text are not trusted evidence. Older completion tokens retain their own conversation snapshot, including when a chat is forked.

Registration does not add a participant to every coding agent's independent panel. Use [MCP](../mcp/setup.md) for clients supporting stdio tools and check the executable's contract. See [privacy](./privacy.md).
