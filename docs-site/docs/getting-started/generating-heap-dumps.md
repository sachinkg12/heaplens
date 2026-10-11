---
sidebar_position: 3
title: Capture a heap dump safely
---

Dumps can contain passwords, tokens, personal data, and business content. Capture only authorized applications, protect the output folder, and never put dumps in public support attachments or source control. Capture can pause the JVM, trigger GC depending on options, and consume substantial disk space. Wait until writing finishes before analysis.

## HotSpot with jcmd

Use a compatible JDK tool and an account permitted to attach:

```bash
jcmd -l
jcmd 12345 GC.heap_dump /secure/captures/app.hprof
```

Replace the PID/path. Check `jcmd 12345 help GC.heap_dump` for that JVM's options. Containers, disabled attach, permissions, and JRE-only installs can prevent capture.

Windows PowerShell:

```powershell
jcmd 12345 GC.heap_dump 'C:\secure\captures\app.hprof'
```

## Capture on out-of-memory

Start a compatible HotSpot JVM with:

```bash
java -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/secure/captures app.Main
```

Ensure a writable destination and capacity first. This does not capture every failure: OS kills, native-memory failures, and incomplete writes are distinct cases.

## Spring Boot Actuator

The authorized, protected endpoint uses **GET**:

```bash
curl --fail --output /secure/captures/app.hprof \
  https://your-protected-service/actuator/heapdump
```

Use your authentication mechanism without leaking tokens in shared commands. Do not publicly expose this endpoint. [Spring documents](https://docs.spring.io/spring-boot/api/rest/actuator/heapdump.html) HPROF on HotSpot but **PHD on OpenJ9**. Renaming PHD to `.hprof` does not convert it.

## Remote and container capture

Run the tool where the PID is visible and attachment allowed. Ensure the container has the tool and writable storage. Copy the completed capture securely or analyze on that machine with a matching binary. Do not replace/truncate mapped files.

See [remote workflows](./remote-development.md) and [format fundamentals](../concepts/heap-dump-fundamentals.md).
