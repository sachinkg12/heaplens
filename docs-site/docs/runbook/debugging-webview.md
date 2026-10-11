---
sidebar_position: 2
title: Debug the right process
---

Renderer, host adapter, and native server are different processes. Inspect the correct one before drawing a conclusion.

| Surface | What to inspect |
| --- | --- |
| VS Code webview | Developer: Open Webview Developer Tools / supported renderer inspector |
| VS Code extension host | HeapLens Output channel, extension-host debugger |
| IntelliJ | IDE logs and supported JCEF inspection/development tools |
| Standalone | Browser developer tools plus launcher/host stderr |
| Native server | Local stderr, process status, RPC responses/notifications |

Developer tools vary by host/version. A browser's normal console is not the native analysis console.

## Small reproduction

Use a safe small dump, record version/backend/platform and the failing action, then check console errors, local asset loading, and the request/notification boundary. Keep the original dump immutable.

Charts use packaged D3, not a CDN. Empty views can come from missing completion data, stale session routing, an unavailable renderer asset, or an actual backend failure. Confirm evidence rather than assuming one cause.

Do not log entire heap analysis objects or API credentials. Names, raw previews, queries, source, file paths, private session URLs, and provider errors can be sensitive. Scrub screenshots/logs before support sharing; local diagnostics are not automatically safe public attachments.

## Maintainer checks

Use read-only mock/native fixtures for consent and request-body tests. Separate first-turn/follow-up AI context and host policies. Test late messages from a retired server, Cancel/Retry, two independent dumps, theme switching, and bounded results.

Never post a real user's full dump to reproduce a UI issue. See [telemetry](./telemetry.md) for bounded diagnostic data and [support](./support.md).
