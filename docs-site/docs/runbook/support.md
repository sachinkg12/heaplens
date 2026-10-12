---
title: Releases, support, and security
---

## Releases and compatibility

Use [GitHub releases](https://github.com/sachinkg12/heaplens/releases) and the repository [changelog](https://github.com/sachinkg12/heaplens/blob/main/CHANGELOG.md) for versioned changes. Check [host availability](../getting-started/choose-host.md) before assuming a merged adapter has a public installer.

Known limitations include differences in tree-percentage denominators, incomplete heap context in VS Code AI follow-up messages, approximate layout and waste estimates, participant model selection, and Monitor security and target-validation constraints. Review the relevant view guides and privacy controls before interpreting results.

## Report a bug safely

Use [GitHub issues](https://github.com/sachinkg12/heaplens/issues) with product version, host/OS/architecture, backend, failing action, expected versus observed behavior, and sanitized bounded diagnostics. Note whether Retry recovers and whether the server actually exits.

Do not attach real dumps, full source, API keys, private session URLs, raw string previews, or unredacted logs. A synthetic small fixture is preferable. Feature usage/telemetry is not proof a generated repair succeeded.

## Privacy requests

Email [sachinkg12@gmail.com](mailto:sachinkg12@gmail.com) with privacy questions or requests. The [HeapLens IntelliJ Privacy Policy](./intellij-privacy-policy.md) covers the plugin's optional AI sharing, local storage, and configured Azure retention. Do not send dumps, credentials, or confidential source unless a suitable private sharing arrangement has been agreed.

## Security reports

Do not disclose an exploitable vulnerability or sensitive data in a public issue. Use the repository's [Security page](https://github.com/sachinkg12/heaplens/security) to check whether private reporting is enabled. This guide does not assert that private GitHub reporting is enabled or promise a response SLA. If no private route is offered, request a private contact without posting exploit details.

[AI privacy](../ai-integration/privacy.md) and [telemetry](./telemetry.md) explain distinct boundaries. Provider/cloud policies are not certified by this site.
