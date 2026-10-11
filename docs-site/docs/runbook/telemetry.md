---
title: Telemetry and local diagnostics
---

VS Code and standalone CLI/browser telemetry default to usage and errors (`all`), subject to their host controls. **IntelliJ telemetry stays off until explicit approval**, as required by the [JetBrains Marketplace approval guidelines](https://plugins.jetbrains.com/docs/marketplace/jetbrains-marketplace-approval-guidelines.html). Permitted telemetry helps distinguish failed operations, analysis phases and feature usage without uploading heap dumps or arbitrary diagnostic text. All hosts use the versioned allowlist in `telemetry/contract.json`; host-specific adapters own preferences, permission and delivery. The Rust analysis library and standalone JSON-RPC/MCP server do not send telemetry.

The [HeapLens IntelliJ Privacy Policy](./intellij-privacy-policy.md) combines IntelliJ telemetry, AI sharing, local storage, and the privacy contact in one policy.

## Controls

| Host | Enable or disable | Local review |
| --- | --- | --- |
| VS Code and compatible editors | Default `all`. Choose **HeapLens: Configure Telemetry → Off**, or set `heaplens.telemetry.level` to `off` in **User** settings. Editor telemetry-off also stops reporting; error-only permission caps it to errors. Workspace settings cannot override the application policy. | **HeapLens: Review Local Diagnostics** opens an unsaved JSON document. |
| IntelliJ | Default **Off**, with no collection or delivery before explicit approval. The first editor offers Errors Only, Usage and Errors, or No Telemetry. Cancel/dismissal remembers Off. Earlier prototype On settings require new approval. Change or withdraw permission through **Telemetry**; the application choice persists locally and is not synced. | **Review Local** in the same dialog. Only records collected with permission appear; Off clears them. |
| One-shot CLI | Default `all` on every invocation. Add `--telemetry off` to every command to disable, or `--telemetry error` for failures only. `DO_NOT_TRACK=1` disables across that environment. | `--diagnostics NEW_FILE` writes a filtered local JSON file, never auto-uploads it, and does not change the telemetry level. Existing files are never overwritten. |
| CLI browser | `heaplens open ... --telemetry off` disables from startup. Without the flag the default is `all`. The browser is the sole telemetry owner for interactive analysis. | Browser **Telemetry** offers local review and immediate disable for the current running host. Relaunch with `--telemetry off` to stay disabled on a future run. |

To send nothing on a first run on any host, set `DO_NOT_TRACK=1` before starting the IDE or CLI. IntelliJ already starts off and does not replay activity from before approval. On other hosts turn telemetry off before opening a dump or launching a command. IDE choices persist; CLI choices do not persist automatically. Local review does not upload the diagnostic report, but permitted routine delivery remains active unless disabled. Dismissing IntelliJ's initial permission dialog keeps it off; cancelling a later configuration dialog leaves the saved choice unchanged.

VS Code extension-development mode, IntelliJ development launch tasks/unit tests, `CI` environments, and `DO_NOT_TRACK=1` disable ordinary reporting. IntelliJ also supports `-Dheaplens.telemetry.disabled=true`. To test Azure delivery, use an installed candidate rather than a development host. Disabling clears queued records and cancels outstanding delivery where possible; already transmitted records cannot be recalled. The [VS Code telemetry guidance](https://code.visualstudio.com/api/extension-guides/telemetry) describes the editor-level permission.

## Fields and purposes

Unknown event names, fields and enum values are rejected. Invalid, negative, non-finite or out-of-range measurements reject the event rather than becoming arbitrary output.

| Field group | Allowed data | Purpose |
| --- | --- | --- |
| Event context | Schema version, host, product version, `darwin`/`win32`/`linux`/unknown, `arm64`/`x64`/unknown | Locate release and platform differences without a machine fingerprint. |
| Failures | Fixed error category and phase; bounded process exit code/signal where available | Distinguish parsing, missing input, timeout, server-start or protocol problems. Unknown remains unknown. A kill signal alone does not prove OOM. |
| Lifecycle | Started, completed, failed, cancelled, Retry and recovered where wired | Identify operation outcomes. No operation, dump, user, machine or session identifier is transmitted. |
| Actions | Fixed tab/action names and selected enum metadata such as provider category, export format or resolution tier where wired | Understand requested workflows. Feature events can represent attempts, not successful completion or valid AI repairs. |
| Measurements | Sizes rounded down to 64 MiB; duration to 100 ms; object counts to 1,000; class counts to 100; suspect counts to 10; bounded minutes/heartbeat count | Approximate workload and performance. Small values can round to zero. These are not exact benchmark measurements. |
| Envelope | UTC send time, existing resource ingestion key, empty identity tags | Deliver custom events to Azure. The resource key is routing configuration, not an API credential. |

Hosts do not necessarily populate every allowed field. The current CLI observes command boundaries and loading/query/output, not every internal parser or dominator phase; it cannot report its own SIGKILL after termination. IntelliJ records structured operation outcomes but some RPC failures remain unknown. No causal root-cause guarantee is made.

Each long-running host retains at most 20 recent filtered records for local review. IntelliJ records nothing while Off and, with Errors Only selected, does not retain usage events. Delivery has a 16-record in-memory queue, a 256-event process/application cap, no disk spool or replay/retry, and short network deadlines. The one-shot CLI sends at most one batch of 16 records after the command with a one-second request deadline. Failure to deliver does not change analysis results or its exit status. The local report is not automatically attached to a support request.

## Privacy limits and cloud checks

This page describes the current source contract reviewed on **11 October 2026**, not a claim about every historical release. The purpose is product reliability and feature-use diagnostics, not advertising or tracking individual developers. Preferences are host-specific; enabling AI is not enabling telemetry, and disabling telemetry does not disable a requested AI call.

No raw exceptions, paths, source/query text, heap strings/primitive values, class names, credentials, custom endpoint URLs or stable identity tags enter this telemetry contract. AI providers and local report/export contents have separate boundaries; enabled telemetry does not approve source submission or support upload.

Removing names and identifiers does not guarantee anonymity. Timing, platform/version and workload combinations can still be identifying, and networks/Azure can process IP addresses. This implementation does not certify legal compliance. Cross-session unique-user and retention metrics are deliberately unavailable rather than reconstructed with a fingerprint.

## Azure configuration

The maintainer supplied successful read-only Azure configuration queries on **October 11, 2026**. They report the following settings for the shared telemetry resource; this documentation update does not change them.

| Setting | Reported configuration and scope |
| --- | --- |
| Region | Application Insights and its Log Analytics workspace: **East US 2, United States**. |
| AppEvents retention | **730 days analytics and 730 days total**, with **0 additional archive days**. The table explicitly overrides workspace retention; the component's legacy 90-day value is not the effective AppEvents retention. |
| IP masking | `DisableIpMasking` is unset, consistent with Azure's default: temporarily process IP for geolocation, then store client IP as `0.0.0.0`. Derived location fields may remain. |
| Workspace replication | No secondary-region replication configuration reported. This is not a guarantee about all Microsoft processing or copies. |
| Automatic workspace exports | No data-export rules configured. This does not exclude manual downloads or other export mechanisms. |
| Reviewed access | One inherited Owner role for the maintainer's Azure account; no other assignments reported for the resource or workspace in the supplied review. This does not exclude Microsoft service operations. |

[Microsoft's retention documentation](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure) explains table overrides; [Microsoft's IP-handling documentation](https://learn.microsoft.com/en-us/azure/azure-monitor/app/ip-collection) explains temporary processing and derived geolocation. Configured table retention is separate from local queue limits. Turning reporting off does not delete information already received by Azure, and this update does not purge historical records.

These configuration reads do not establish the contents of historical events or prove that a particular installed release's events reached Logs. Check those separately before release acceptance. An HTTP success alone does not prove portal visibility; see [Microsoft's ingestion troubleshooting guidance](https://learn.microsoft.com/en-us/troubleshoot/azure/azure-monitor/app-insights/telemetry/investigate-missing-telemetry).

For privacy questions, email [sachinkg12@gmail.com](mailto:sachinkg12@gmail.com). For non-confidential diagnostic questions, use the [support guide](./support.md). Do not attach a dump, source file, credentials, or raw private logs to a public issue. A reviewed local diagnostic report is optional and never automatically uploaded.
