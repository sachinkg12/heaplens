---
title: Use HeapLens in a browser
---

Open HeapLens in a local browser to investigate a heap dump without an IDE. The native analysis server runs on your computer; the browser displays its results and provides queries, source viewing, downloads and optional AI assistance.

Start with the [standalone installation guide](./standalone.md). A complete package includes the CLI, analysis server and browser assets. Browser mode requires Node.js; the packaged npm launcher requires native ARM64 Node 22 or newer on its current Apple Silicon target.

## Open a dump

Replace these example paths with your own completed dump and Java source directory:

```bash
heaplens open "/absolute/path/app.hprof" \
  --source-root "/absolute/path/java-project/src" --telemetry off
```

Omit `--source-root` if you only need heap analysis. Supply a narrow directory that you approve for local reading; repeat the option for additional roots, up to sixteen. Source lookup stays within these roots, skips linked files/directories and reads at most 256 KiB per Java file. Choose narrower roots if lookup exceeds 50,000 scanned entries or twenty matches for a class.

Keep the terminal running. HeapLens opens your default browser and prints a private launch URL. Use `--no-browser` to open the printed URL yourself. The URL grants access to this local session: do not share it or include it in screenshots and support logs. If a reload loses access, reopen the original launch URL.

## Investigate and export

| View or action | What you can do |
| --- | --- |
| Overview | Read summary and charts; copy an incident report or download the Markdown fallback. |
| Histogram | Filter and sort classes, view instance previews, inspect objects, trace roots/referrers and download CSV. |
| Dominator Tree | Expand owners, inspect fields, follow root paths and open the bounded Flame Graph. These are domination relationships, not every reference connection. |
| Leak Suspects and Waste | Investigate heuristic suspects and estimated waste; local previews are not automatically included in AI context. |
| Source | View matching Java files read-only. Choose between duplicate matches. Dependency source-JAR lookup and an IDE decompiler are not provided. |
| Query | Run HeapQL with highlighting, help, result pages and page-local history. Use the [CLI](../api-reference/cli.md) for machine-readable query exports. |
| Compare and Timeline | Investigate completed snapshots and download available comparison reports. File modification times are not verified capture timestamps. |
| Monitor | Connect to a separately running, authorized JVM metrics agent. Opening a dump does not attach to an application. |
| AI Chat and Explain | Configure a provider and model, approve the request, ask questions, stop generation and export the retained recent conversation. |
| Fix with AI | Approve sending the full selected source file, review the proposal beside the original, and download the proposed Java file. HeapLens does not overwrite the original. |

Downloads follow your browser's destination and overwrite settings, not the terminal CLI's create-new file protection. Reports and exports can contain sensitive names, values or paths; review them before sharing.

Browser object actions require IDs within JavaScript's safe integer range, up to 9,007,199,254,740,991. Larger IDs are rejected rather than silently rounded; use precision-preserving terminal query output for those IDs.

## Multiple dumps and recovery

```bash
heaplens open "/absolute/path/before.hprof" "/absolute/path/after.hprof" \
  --telemetry off
```

Up to eight supplied dumps can be opened. Select a dump and wait for its analysis to complete before using its results. New analyses run one at a time, but completed graphs remain in memory until their dump is closed; multiple dumps can still require substantial RAM.

Use **Cancel** to request cancellation and **Retry** after a failed analysis or server exit. Closing one dump releases its server without closing the others. Stop the terminal command with Ctrl+C when finished. The host also stops after ninety seconds without authenticated browser requests, or five minutes if no browser has connected; these are connection-idle limits, not analysis deadlines. See [troubleshooting](../runbook/troubleshooting.md) if the host cannot start.

## AI and telemetry

The browser offers ten provider presets with editable model IDs and supported custom endpoints. A model must support the selected provider's request format; editable names do not guarantee access to every model.

API keys and recent conversations stay in the running host's memory. Chat approval is per dump and configuration. Clear, Configure, Retry, closing/reopening or changing the destination/model/key requires approval again. Explain and full-source submission have separate approvals. Chat export contains only the bounded recent completed conversation, not an unlimited transcript.

Automatic context omits raw heap-string previews, primitive field contents, source bodies and absolute source paths. Names, typed messages and explicitly approved full source may still be sensitive. Approved source is not redacted. A localhost AI endpoint may forward requests remotely. Read [AI privacy](../ai-integration/privacy.md) before using these actions.

Standalone telemetry defaults to usage and errors. Use `--telemetry off` on every launch, or set `DO_NOT_TRACK=1`, to disable it. The browser's Telemetry control can disable reporting for the current running host. AI approval and telemetry permission are separate. See [telemetry controls](../runbook/telemetry.md).

The browser host listens only on loopback. It is not a public, multi-user server. For remote access, use an authorized tunnel and the [remote development guide](./remote-development.md).
