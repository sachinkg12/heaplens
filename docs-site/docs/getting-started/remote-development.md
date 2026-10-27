---
title: Remote development and coding agents
---

Ask **which machine owns the process and file**. A laptop path is not automatically accessible over SSH, in a container, in an IDE backend, or in a client sandbox.

| Workflow | Analysis machine | Required there |
| --- | --- | --- |
| Download completed dump, open locally | Local native host | Authorized file and matching binary |
| Remote extension host | Extension-host machine | Target package, dump, RAM |
| Standalone over SSH | SSH server | Matching CLI/runtime and readable paths |
| Agent through MCP | Configured MCP server machine | Trusted executable and explicitly permitted filesystem |

## Headless remote analysis

Run `heaplens analyze` or `query` on the server, retrieve the report securely, and preserve access controls. Current standalone packaging is Apple Silicon-only; a matching Linux/Windows binary is a separate distribution step.

Browser `--no-browser` avoids launching a remote desktop. Loopback forwarding can transport a local port but is not a validated multi-user service. The private URL is an access capability. Never expose the bind address or share its URL publicly.

## Agents through MCP

A stdio-MCP client can launch the updated server with `--mcp`, exact-file `--mcp-allow-file` arguments and `--mcp-share-metadata`. A human approves server-machine files in launch configuration; tool arguments cannot add paths. The file is not uploaded by the server, but approved metadata can be forwarded to the client's model. Raw contents, previews and source are excluded from this interface.

MCP support is not a promise for every client/version. Verify initialization, tools/list, an approved alias, a bounded metadata read and cancellation on a safe dump. See [setup](../mcp/setup.md) and [privacy](../ai-integration/privacy.md).

Slack, Teams, Discord, and other messaging services are not built-in analysis hosts. Sharing a report discloses its contents to the service/recipients. Future integrations require explicit upload, authentication, retention, and authorization design.
