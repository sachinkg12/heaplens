---
title: HeapLens IntelliJ Privacy Policy
---

Last updated: **October 16, 2026**

Applies to: **HeapLens for IntelliJ IDEA**

HeapLens is an open-source heap-analysis tool maintained by Sachin Gupta. This policy explains local processing, optional telemetry, and optional AI data sharing in the IntelliJ plugin. Other HeapLens distributions have different controls; see the [cross-host telemetry guide](./telemetry.md) and [AI data-sharing guide](../ai-integration/privacy.md).

Privacy contact: [sachinkg12@gmail.com](mailto:sachinkg12@gmail.com).

## Local heap analysis

HeapLens analyzes heap dumps locally using its bundled analysis server. Opening or analyzing a dump does not automatically upload the dump or make an AI request. Optional telemetry, if approved, sends only the diagnostic information described below.

Source navigation also runs locally. Reports, exports, and copied analysis results may contain sensitive information. Review them before sharing.

## Optional telemetry

IntelliJ telemetry is **off until you explicitly approve it**. The initial permission dialog offers **Errors Only**, **Usage and Errors**, or **No Telemetry**. Dismissing that dialog keeps telemetry off and remembers that choice. No earlier activity is replayed after approval.

Approved telemetry is sent to Microsoft Azure Application Insights to investigate failures and understand feature usage. Depending on your selection and the operation, records may include:

- Plugin and telemetry-schema versions, operating-system category, and CPU architecture.
- Fixed operation, feature, provider-category, source-resolution, error-category, and analysis-phase labels.
- Process exit codes or signals, where available.
- Rounded workload sizes, counts, and operation durations.
- Event timestamps.

HeapLens telemetry excludes heap contents, source code, query text, chat messages, class names, file paths, credentials, custom endpoint URLs, raw exception messages, and stable user, machine, dump, or session identifiers. The [telemetry guide](./telemetry.md#fields-and-purposes) describes the allowed fields and rounding limits.

These exclusions reduce exposure but **do not guarantee anonymity**. Combinations of technical information may still be identifying. Network services process connection information, including IP addresses.

Choose **Telemetry → Off** to withdraw permission. This clears locally retained telemetry records and pending delivery, and cancels outstanding delivery where possible. It cannot recall information already transmitted. **Review Local** lets you inspect filtered local diagnostics without uploading that report; routine approved telemetry remains active until disabled.

## Azure storage and retention

As of October 11, 2026, the Application Insights resource and its Log Analytics workspace are configured in **East US 2, United States**. Approved custom telemetry events use the **AppEvents** table, configured for **730 days of analytics retention and 730 days of total retention**, with no additional archive retention. The table has an explicit retention setting; the Application Insights component's legacy 90-day value is not the effective AppEvents retention period. [Microsoft explains workspace and table retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure).

No automatic workspace data-export rules or secondary-region workspace replication are configured. The reviewed Azure role assignments grant access only to the maintainer's Azure account. Microsoft operates the underlying service. These configuration statements do not guarantee that all Microsoft service processing or copies occur only in that region, or cover any manually exported copies.

The current IP-masking setting uses Azure's default behavior: an IP address is temporarily processed for geolocation, then discarded from the telemetry record, whose client-IP field is stored as `0.0.0.0`. Derived city, region, or country information may remain. This is not a claim that IP addresses are never processed or that telemetry is completely anonymous. [Microsoft documents IP handling](https://learn.microsoft.com/en-us/azure/azure-monitor/app/ip-collection).

Turning telemetry off stops future reporting; it does not delete events already received by Azure. The local queue limits are separate from cloud retention.

## Optional AI assistance

AI features use the provider and endpoint you configure. Opening a dump does not automatically send information to that provider.

**AI Chat and Explain** in the updated local implementation can send your messages, recent completed conversation turns and bounded heap metadata, including exact identifiers, counts, sizes, class/field names and types, reference summaries and root-path metadata. One question can use up to four model calls and three read-only engine reads within 90 seconds. Approval applies to this dump-editor investigation session and configuration, not other dump editors. Stop, Clear, Configure AI, Retry, closing the dump or changing provider, endpoint, model or API key revokes approval. Older published packages may use a different request flow; inspect the permission dialog of the package you are using.

**Fix with AI** requests explicit approval before sending the **entire selected project source file**, together with relevant heap metadata. Approved source is not redacted and may contain secrets, comments, proprietary code, or personal information. The local absolute source path is not included in the prompt. Cancel or Review Source sends nothing for that request; Review Source opens the file locally and cancels transmission.

Automatic AI context omits raw heap-string previews and primitive field contents. Names, messages you type, conversation history, and approved source may nevertheless be sensitive. The configured provider receives authentication credentials needed for the approved request.

The provider's retention, logging, training, and processing-location policies apply. Review those policies before approving transmission. A localhost endpoint can forward requests elsewhere; it does not guarantee local-only processing.

Stopping a request or clearing local history cannot recall data already received by a provider. AI suggestions may be incorrect; review and test proposed changes before applying them.

## Local storage

Optional **Disk-backed references** can persist structural indexes locally. These contain object IDs, HPROF metadata strings, class/field metadata, modeled sizes, reference connections, array lengths, byte offsets, checksums and a full-content cryptographic fingerprint of the capture. The algorithm is recorded in the cache manifest. They do not persist raw primitive-array buffers or duplicate-string previews. This metadata can be sensitive and is not encrypted or automatically uploaded by index construction. Memory storage is the default and does not create reusable structural indexes; switching back to Memory does not delete existing indexes.

Completed indices remain after closing the dump so they can be reused. Normal failed/cancelled construction removes its unpublished temporary directory; forced process termination can leave an ignored partial directory. Close all analyses using the files before deleting selected HeapLens cache directories through your file manager. Index location and operating-system permission requirements are described in the [CLI storage guide](../api-reference/cli.md#disk-reference-storage). The original dump and mapped index files must remain unchanged while open.

The shared analysis engine also uses local coordination files containing resource-reservation counts. These files do not contain heap contents and do not authorize telemetry or AI transmission.

Provider settings and telemetry preferences persist locally and are configured not to roam through IntelliJ settings synchronization. API keys are managed through **IntelliJ Password Safe**; persistence depends on its configuration, which may be memory-only.

Completed AI conversations are cached in the local IDE system directory, bounded to **four exchanges and 24,000 characters per dump**. HeapLens does not encrypt this cache. Restored conversations are display-only and are not forwarded as evidence to a new investigation. Use **Clear** in AI Chat to remove saved conversation; a removal failure is displayed. Closing a dump does not itself delete its saved conversation.

Local diagnostic records are bounded and held in memory, not a disk spool. IntelliJ retains at most 20 recent filtered records while permitted by your telemetry choice; Off clears them. Exported files remain wherever you save them and are under your control.

## Third-party services

Microsoft Azure receives approved telemetry. Your configured AI service receives approved AI requests and the credentials required to authenticate them. Their processing practices are separate from HeapLens' local controls. IntelliJ IDEA and JetBrains Marketplace have their own policies outside the scope of this plugin policy.

Disabling telemetry does not disable optional AI requests, and telemetry approval does not authorize source sharing.

## Questions and requests

Email [sachinkg12@gmail.com](mailto:sachinkg12@gmail.com) with privacy questions or requests. Use [GitHub issues](https://github.com/sachinkg12/heaplens/issues) for non-confidential product questions. Do not send heap dumps, API keys, or confidential source unless a suitable private sharing arrangement has been agreed.

Because telemetry contains no stable user identifier, identifying a particular person's records may not be possible. This policy will be updated when relevant data-handling practices change.
