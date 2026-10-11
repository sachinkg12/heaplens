---
sidebar_position: 6
title: Source
---

import FlowDiagram from '@site/src/components/FlowDiagram';

Source connects a heap class name to locally available code. It does not establish that the class owning memory is where a repair belongs.

<FlowDiagram kind="source" />

## Different host lookup tiers

| Host | Candidates / resolution |
| --- | --- |
| VS Code | Filtered workspace candidates; excludes java., javax., sun., com.sun., jdk. prefixes. Project search and supported dependency-source resolution are separate tiers |
| IntelliJ | Broader class list including libraries/JDK; project files, attached sources, then IDE decompiler. Libraries must belong to the project; no automatic downloads |
| Browser | Java files under explicitly supplied source roots; no dependency-JAR lookup or IDE decompiler |

VS Code “resolvable classes” is a candidate count, not proof each file exists. IntelliJ “matching classes / opened locally” counts a different list and actual openings. A 200-row display limit is not the complete matching total: filter to find omitted classes. Different counts or java.lang.String visibility alone do not prove numerical heap mismatch.

Inner classes typically open their containing file, not an exact declaration. Duplicate-name/project matches may need a chooser. Source from another version can be misleading.

## Fix with AI is independent

Press Fix with AI without first opening source; the host can resolve it independently. Only eligible **project source** may be submitted as an editable repair target. A visible action does not guarantee a dependency/decompiled file is eligible.

Approve the actual destination and **entire file**. Review Source opens locally and cancels transmission; Cancel sends nothing. Credentials and primitive-value filtering are not source redaction.

## Proposal versus applied change

Review differences first. IntelliJ uses native proposal/apply and Undo support; VS Code uses its editor diff/proposal workflow; browser proposals use host-specific local-file/download controls. Read labels and confirm the actual target—do not assume arrows or a download already modified the project.

Recheck changed code, build/tests, and equivalent captures. Source changed since approval must not silently overwrite newer edits. See [privacy](../ai-integration/privacy.md) and [host scope](../getting-started/choose-host.md).
